// POST /api/auth/register/options { invite } → { ok, options: PublicKeyCredentialCreationOptionsJSON, user: { name, email } }
// Validates the one-time invite and stores the registration challenge (challenge:reg-{jti}, 5 min).
import { authError, passkeyCreationOptions, publicUser, rpInfo } from '../../../_lib/auth.js';
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
    const options = await passkeyCreationOptions(rpInfo(req, config).rpId, user, await store.listCredIds(user.email));
    await store.putChallenge(`reg-${invite.jti}`, { challenge: options.challenge, jti: invite.jti, email: user.email });
    return jsonResponse({ ok: true, options, user: publicUser(user) });
  } catch (err) {
    console.error('[access] register/options failed:', err);
    return authError('store_failed');
  }
}
