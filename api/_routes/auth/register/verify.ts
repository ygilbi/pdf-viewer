// POST /api/auth/register/verify { invite, response: RegistrationResponseJSON } → { ok, user, credentialId } + pv_session cookie.
// Verifies the attestation (platform authenticator only — cross-platform → 400 not_platform), stores the passkey, consumes the invite (single use) and activates the user.
import { authError, publicUser, sessionCookie, verifyPasskeyRegistration } from '../../../_lib/auth.js';
import { checkInvite } from '../../../_lib/invite.js';
import { clientIp, configOrError, createRateLimiter, jsonWithCookies, readJsonBody } from '../../../_lib/http.js';
import { getStore } from '../../../_lib/store.js';
import { notifyOwnerRegistered } from '../../../_lib/decision.js';
import { nowSeconds } from '../../../_lib/token.js';

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

  const now = nowSeconds();
  const v = await verifyPasskeyRegistration(req, config, user, body.response, challenge.challenge, now);
  if (!v.ok) return authError(v.code);

  try {
    if (await store.getCred(v.id)) return authError('credential_exists');
    if (!(await store.consumeInvite(invite.jti))) return authError('invite_used');
    await store.putCred(v.id, v.cred);
    user = { ...user, status: 'active' as const, activatedAt: now };
    await store.putUser(user);
  } catch (err) {
    console.error('[access] register/verify store error:', err);
    return authError('store_failed');
  }
  console.log(`[access] registered passkey for ${user.email}`);

  await notifyOwnerRegistered(req, user, 'passkey');
  return jsonWithCookies({ ok: true, user: publicUser(user), credentialId: v.id }, [await sessionCookie(req, config, user)]);
}
