// POST /api/auth/register/verify { invite, response: RegistrationResponseJSON } → { ok, user } + pv_session cookie.
// Verifies the attestation, stores the passkey, consumes the invite (single use) and activates the user.
import { verifyRegistrationResponse, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { authError, looksLikeCredentialJson, publicUser, rpInfo, sessionCookie } from '../../../_lib/auth.js';
import { checkInvite } from '../../../_lib/invite.js';
import { appBaseUrl, clientIp, configOrError, createRateLimiter, jsonWithCookies, readJsonBody } from '../../../_lib/http.js';
import { getStore } from '../../../_lib/store.js';
import { ConfigError, loadConfig } from '../../../_lib/config.js';
import { getMailer } from '../../../_lib/mailer.js';
import { ownerRegisteredEmail } from '../../../_lib/templates.js';
import { revokeUrl } from '../../../_lib/decision.js';
import { REVOKE_TTL_DAYS, nowSeconds } from '../../../_lib/token.js';

const limiter = createRateLimiter(30, 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  if (!limiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '60' });
  const parsed = await readJsonBody(req, 64 * 1024);
  if (parsed.error) return parsed.error;
  const body = (parsed.body ?? {}) as { invite?: unknown; response?: unknown };
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);

  let user, invite, challenge;
  try {
    const check = await checkInvite(body.invite, config.signingSecret, store);
    if (!check.ok) return authError(check.code);
    ({ user, invite } = check);
    challenge = await store.takeChallenge(`reg-${invite.jti}`);
  } catch (err) {
    console.error('[access] register/verify store error:', err);
    return authError('store_failed');
  }
  if (!challenge || challenge.jti !== invite.jti) return authError('challenge_expired');
  if (!looksLikeCredentialJson(body.response)) return authError('bad_request');

  const rp = rpInfo(req, config);
  let info;
  try {
    const result = await verifyRegistrationResponse({
      response: body.response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
    });
    if (!result.verified) return authError('verification_failed');
    info = result.registrationInfo;
  } catch (err) {
    console.warn(`[access] registration verification failed for ${user.email}:`, (err as Error)?.message);
    return authError('verification_failed');
  }

  const now = nowSeconds();
  try {
    const credId = info.credential.id;
    if (await store.getCred(credId)) return authError('credential_exists');
    if (!(await store.consumeInvite(invite.jti))) return authError('invite_used');
    const transports =
      info.credential.transports ?? ((body.response as { response: { transports?: unknown } }).response.transports as string[] | undefined) ?? [];
    await store.putCred(credId, {
      userEmail: user.email,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      transports: Array.isArray(transports) ? transports.filter((t) => typeof t === 'string').slice(0, 8) : [],
      createdAt: now,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
    user = { ...user, status: 'active' as const, activatedAt: now };
    await store.putUser(user);
  } catch (err) {
    console.error('[access] register/verify store error:', err);
    return authError('store_failed');
  }
  console.log(`[access] registered passkey for ${user.email}`);

  // Tell the owner (best effort) — this mail carries the revoke link.
  try {
    const full = loadConfig(['mail', 'owner']);
    const url = revokeUrl(appBaseUrl(req, full), full.signingSecret, user.name, user.email, REVOKE_TTL_DAYS);
    await getMailer(full.mail).send({
      to: full.ownerEmail,
      replyTo: user.email,
      ...ownerRegisteredEmail({ name: user.name, email: user.email, revokeUrl: url }),
    });
  } catch (err) {
    if (err instanceof ConfigError) console.warn(`[access] owner not notified of registration: ${err.message}`);
    else console.error('[access] failed to notify owner of registration:', err);
  }

  return jsonWithCookies({ ok: true, user: publicUser(user) }, [await sessionCookie(req, config, user)]);
}
