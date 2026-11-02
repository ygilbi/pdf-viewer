// POST /api/auth/login/verify { response: AuthenticationResponseJSON } → { ok, user } + pv_session cookie.
// Looks the passkey up by credential id, requires the user to be 'active', verifies the assertion
// (user verification required) and stores the new signature counter.
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  CHALLENGE_COOKIE_PATH,
  authError,
  looksLikeCredentialJson,
  publicUser,
  readChallengeCookie,
  rpInfo,
  sessionCookie,
} from '../../../_lib/auth.js';
import { clientIp, configOrError, cookieSecure, createRateLimiter, jsonWithCookies, readJsonBody, serializeCookie } from '../../../_lib/http.js';
import { CHALLENGE_COOKIE } from '../../../_lib/session.js';
import { getStore, type CredentialRecord, type UserRecord } from '../../../_lib/store.js';
import { nowSeconds } from '../../../_lib/token.js';

const limiter = createRateLimiter(30, 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  if (!limiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '60' });
  const parsed = await readJsonBody(req, 64 * 1024);
  if (parsed.error) return parsed.error;
  const response = (parsed.body as { response?: unknown } | null)?.response;
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);
  const clearChal = serializeCookie(CHALLENGE_COOKIE, '', { maxAge: 0, path: CHALLENGE_COOKIE_PATH, secure: cookieSecure(req) });

  const chalId = readChallengeCookie(req);
  if (!chalId) return authError('challenge_expired');
  if (!looksLikeCredentialJson(response)) return authError('bad_request');

  let challenge, cred: CredentialRecord | null, user: UserRecord | null;
  try {
    challenge = await store.takeChallenge(chalId);
    if (!challenge) return authError('challenge_expired');
    cred = await store.getCred(response.id);
    user = cred ? await store.getUser(cred.userEmail) : null;
  } catch (err) {
    console.error('[access] login/verify store error:', err);
    return authError('store_failed');
  }
  if (!cred) return authError('unknown_credential');
  if (!user || user.status !== 'active') return authError('not_active');
  const userHandle = (response.response as { userHandle?: unknown }).userHandle;
  if (typeof userHandle === 'string' && userHandle && userHandle !== user.id) return authError('verification_failed');

  const rp = rpInfo(req, config);
  let newCounter: number;
  try {
    const result = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      credential: {
        id: response.id,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
        counter: cred.counter,
        transports: cred.transports as never,
      },
    });
    if (!result.verified) return authError('verification_failed');
    newCounter = result.authenticationInfo.newCounter;
  } catch (err) {
    console.warn(`[access] login verification failed for ${user.email}:`, (err as Error)?.message);
    return authError('verification_failed');
  }

  try {
    await store.putCred(response.id, { ...cred, counter: newCounter, lastUsedAt: nowSeconds() });
  } catch (err) {
    console.error('[access] failed to update passkey counter:', err);
    return authError('store_failed');
  }
  console.log(`[access] login ${user.email}`);
  return jsonWithCookies({ ok: true, user: publicUser(user) }, [await sessionCookie(req, config, user), clearChal]);
}
