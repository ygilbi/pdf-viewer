// POST /api/auth/register/options { invite } → { ok, options: PublicKeyCredentialCreationOptionsJSON, user: { name, email } }
// Validates the one-time invite and stores the registration challenge (challenge:reg-{jti}, 5 min).
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { RP_NAME, authError, publicUser, rpInfo } from '../../../_lib/auth.js';
import { checkInvite } from '../../../_lib/invite.js';
import { clientIp, configOrError, createRateLimiter, jsonResponse, readJsonBody } from '../../../_lib/http.js';
import { getStore } from '../../../_lib/store.js';

const limiter = createRateLimiter(30, 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  if (!limiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '60' });
  const parsed = await readJsonBody(req, 16 * 1024);
  if (parsed.error) return parsed.error;
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);
  try {
    const check = await checkInvite((parsed.body as { invite?: unknown })?.invite, config.signingSecret, store);
    if (!check.ok) return authError(check.code);
    const { user, invite } = check;
    const { rpId } = rpInfo(req, config);
    const existing = await store.listCredIds(user.email);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId,
      userName: user.email,
      userDisplayName: user.name,
      userID: new Uint8Array(Buffer.from(user.id, 'base64url')),
      attestationType: 'none',
      timeout: 120_000,
      excludeCredentials: existing.map((id) => ({ id })),
      // Discoverable + user verification (Face ID / fingerprint / Windows Hello). No authenticatorAttachment:
      // a phone via cross-device (hybrid/QR) must remain possible; the hints only express a preference.
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    });
    options.hints = ['client-device', 'hybrid'];
    await store.putChallenge(`reg-${invite.jti}`, { challenge: options.challenge, jti: invite.jti, email: user.email });
    return jsonResponse({ ok: true, options, user: publicUser(user) });
  } catch (err) {
    console.error('[access] register/options failed:', err);
    return authError('store_failed');
  }
}
