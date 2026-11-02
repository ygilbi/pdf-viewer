// GET /api/auth/google/callback?code&state — Google redirects here after the consent screen.
// Verifies the signed state + the pv_gstate cookie (same nonce), exchanges the code, verifies the ID token
// (signature via Google JWKS, iss, aud, exp, nonce, email_verified). Google only proves the email address;
// access is still the owner's decision:
//   'active'   → pv_session → 302 <next> (default "/")
//   'approved' → approved by the owner, not registered yet: Google verified the email, so registration is
//                completed here (outstanding invites voided, status 'active', owner notified with a revoke
//                link) → pv_session → 302 /welcome
//   'denied'   → 302 /login?google=denied
//   unknown / 'pending' / 'revoked' → access request exactly like POST /api/auth/request (owner gets the
//                approve/deny email, unless the user is already 'pending' with a request in the last 24 h)
//                → 302 /login?google=pending&email=<email>
//   errors     → 302 /login?google=error&reason=<code> (see GoogleErrorReason in api/_lib/google.ts)
import { sessionCookie } from '../../../_lib/auth.js';
import { AccessRequestError, submitAccessRequest } from '../../../_lib/access-request.js';
import { ConfigError, googleFromEnv, loadConfig, type Config } from '../../../_lib/config.js';
import { notifyOwnerRegistered } from '../../../_lib/decision.js';
import {
  GSTATE_COOKIE,
  GoogleAuthError,
  clearStateCookie,
  exchangeCode,
  googleErrorRedirect,
  redirect,
  sameString,
  verifyIdToken,
  verifyState,
  type GoogleIdentity,
} from '../../../_lib/google.js';
import { appBaseUrl, clientIp, configOrError, createRateLimiter } from '../../../_lib/http.js';
import { readCookie } from '../../../_lib/session.js';
import { getStore, type UserRecord } from '../../../_lib/store.js';
import { nowSeconds } from '../../../_lib/token.js';

export const googleCallbackLimiter = createRateLimiter(30, 10 * 60 * 1000);
/** Do not email the owner again for a user who is already 'pending' with a request younger than this. */
export const REQUEST_DEDUPE_SECONDS = 24 * 60 * 60;

export async function GET(req: Request): Promise<Response> {
  if (!googleCallbackLimiter.hit(clientIp(req))) return googleErrorRedirect(req, 'rate_limited');
  if (!googleFromEnv()) return googleErrorRedirect(req, 'google_disabled');
  const { config, error } = configOrError(['kv'], 'html');
  if (error) return error;
  const google = config.google!;
  const params = new URL(req.url).searchParams;
  const now = nowSeconds();

  const googleError = params.get('error');
  if (googleError) return googleErrorRedirect(req, googleError === 'access_denied' ? 'access_denied' : 'google_error');

  const checked = verifyState(params.get('state'), config.signingSecret, now);
  if (!checked.ok) return googleErrorRedirect(req, checked.reason);
  const state = checked.state;
  const cookieNonce = readCookie(req.headers.get('cookie'), GSTATE_COOKIE);
  if (!cookieNonce || !sameString(cookieNonce, state.nonce)) return googleErrorRedirect(req, 'state_invalid');
  const code = params.get('code');
  if (!code || code.length > 2048) return googleErrorRedirect(req, 'state_invalid');

  const base = appBaseUrl(req, config);
  let id: GoogleIdentity;
  try {
    id = await verifyIdToken(await exchangeCode(google, base, code), google.clientId, state.nonce, now);
  } catch (err) {
    if (err instanceof GoogleAuthError) return googleErrorRedirect(req, err.code);
    throw err;
  }

  const store = getStore(config.kv);
  let user: UserRecord | null;
  try {
    user = await store.getUser(id.email);
  } catch (err) {
    console.error('[access] google callback store error:', err);
    return googleErrorRedirect(req, 'store_failed');
  }

  if (user?.status === 'active') {
    if (user.googleSub !== id.sub) {
      try {
        await store.putUser({ ...user, googleSub: id.sub });
      } catch (err) {
        console.warn('[access] could not record googleSub:', err);
      }
    }
    console.log(`[access] login (google) ${id.email}`);
    return redirect(state.next, [clearStateCookie(req), await sessionCookie(req, config, user)]);
  }

  if (user?.status === 'approved') {
    try {
      await store.consumeUserInvites(id.email);
      user = { ...user, status: 'active', activatedAt: now, googleSub: id.sub };
      await store.putUser(user);
    } catch (err) {
      console.error('[access] google registration store error:', err);
      return googleErrorRedirect(req, 'store_failed');
    }
    console.log(`[access] registered ${id.email} (google)`);
    await notifyOwnerRegistered(req, user, 'google');
    return redirect('/welcome', [clearStateCookie(req), await sessionCookie(req, config, user)]);
  }

  if (user?.status === 'denied') {
    console.log(`[access] google sign-in by denied ${id.email}`);
    return redirect('/login?google=denied', [clearStateCookie(req)]);
  }

  // Unknown, pending or revoked: ask the owner (same as the request form).
  let full: Config;
  try {
    full = loadConfig(['mail', 'owner', 'kv']);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`[access] configuration error: ${err.message}`);
    return googleErrorRedirect(req, 'server_config');
  }
  try {
    const status = await submitAccessRequest(
      req,
      full,
      store,
      { name: id.name, email: id.email },
      { via: 'google', dedupeSeconds: REQUEST_DEDUPE_SECONDS, extra: { googleSub: id.sub } },
    );
    console.log(`[access] google sign-in by unapproved ${id.email}: ${status} ip=${clientIp(req)}`);
    if (status === 'already_active') {
      // Became active in the meantime (race with a parallel registration): just sign in.
      const fresh = await store.getUser(id.email);
      if (fresh?.status === 'active') return redirect(state.next, [clearStateCookie(req), await sessionCookie(req, config, fresh)]);
    }
  } catch (err) {
    if (!(err instanceof AccessRequestError)) throw err;
    return googleErrorRedirect(req, err.code);
  }
  return redirect(`/login?google=pending&email=${encodeURIComponent(id.email)}`, [clearStateCookie(req)]);
}
