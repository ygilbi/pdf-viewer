// POST /api/auth/passkey/add/verify { response: RegistrationResponseJSON } → { ok, user, hasPasskey: true }
// For a signed-in user: verifies the attestation (same checks as registration) and stores the extra passkey.
import { authError, currentUser, publicUser, verifyPasskeyRegistration } from '../../../../_lib/auth.js';
import { clientIp, configOrError, createRateLimiter, jsonResponse, readJsonBody } from '../../../../_lib/http.js';
import { getStore, normEmail, type ChallengeRecord, type UserRecord } from '../../../../_lib/store.js';
import { nowSeconds } from '../../../../_lib/token.js';
import { addPasskeyChallengeId } from './options.js';

const limiter = createRateLimiter(30, 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  if (!limiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '60' });
  const parsed = await readJsonBody(req, 64 * 1024);
  if (parsed.error) return parsed.error;
  const response = (parsed.body as { response?: unknown } | null)?.response;
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);

  let user: UserRecord | null, challenge: ChallengeRecord | null;
  try {
    user = await currentUser(req, config, store);
    if (!user) return authError('unauthenticated');
    challenge = await store.takeChallenge(addPasskeyChallengeId(user.email));
  } catch (err) {
    console.error('[access] passkey/add/verify store error:', err);
    return authError('store_failed');
  }
  if (!challenge || challenge.email !== normEmail(user.email)) return authError('challenge_expired');

  const now = nowSeconds();
  const v = await verifyPasskeyRegistration(req, config, user, response, challenge.challenge, now);
  if (!v.ok) return authError(v.code);

  try {
    if (await store.getCred(v.id)) return authError('credential_exists');
    await store.putCred(v.id, v.cred);
  } catch (err) {
    console.error('[access] passkey/add/verify store error:', err);
    return authError('store_failed');
  }
  console.log(`[access] added passkey for ${user.email}`);
  return jsonResponse({ ok: true, user: publicUser(user), hasPasskey: true });
}
