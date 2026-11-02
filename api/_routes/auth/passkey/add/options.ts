// POST /api/auth/passkey/add/options {} → { ok, options: PublicKeyCredentialCreationOptionsJSON, user }
// For a signed-in user (pv_session): creation options for an ADDITIONAL passkey on this device (e.g. after
// logging in with an email code). Challenge stored as challenge:addpk-{email} (5 min). 401 when not signed in.
import { authError, currentUser, passkeyCreationOptions, publicUser, rpInfo } from '../../../../_lib/auth.js';
import { clientIp, configOrError, createRateLimiter, jsonResponse } from '../../../../_lib/http.js';
import { getStore, normEmail } from '../../../../_lib/store.js';

const limiter = createRateLimiter(30, 60 * 1000);

export const addPasskeyChallengeId = (email: string): string => `addpk-${normEmail(email)}`;

export async function POST(req: Request): Promise<Response> {
  if (!limiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '60' });
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);
  try {
    const user = await currentUser(req, config, store);
    if (!user) return authError('unauthenticated');
    const options = await passkeyCreationOptions(rpInfo(req, config).rpId, user, await store.listCredIds(user.email));
    await store.putChallenge(addPasskeyChallengeId(user.email), { challenge: options.challenge, email: normEmail(user.email) });
    return jsonResponse({ ok: true, options, user: publicUser(user) });
  } catch (err) {
    console.error('[access] passkey/add/options failed:', err);
    return authError('store_failed');
  }
}
