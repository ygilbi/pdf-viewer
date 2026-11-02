// GET /api/auth/google/start?next=/path → 302 to Google's consent screen (OAuth 2.0 authorization code flow).
// state = signed, 10-minute token { nonce, next }; the same nonce goes to Google (echoed in the ID token) and
// into the HttpOnly cookie pv_gstate (SameSite=Lax, Path=/api/auth/google), binding the flow to this browser.
// Google disabled (no GOOGLE_CLIENT_ID/SECRET) → 302 /login?google=error&reason=disabled.
import { randomId } from '../../../_lib/auth.js';
import { googleFromEnv } from '../../../_lib/config.js';
import {
  GSTATE_COOKIE,
  GSTATE_COOKIE_PATH,
  GSTATE_TTL_SECONDS,
  authorizationUrl,
  googleErrorRedirect,
  redirect,
  safeNext,
  signState,
} from '../../../_lib/google.js';
import { appBaseUrl, clientIp, configOrError, cookieSecure, createRateLimiter, serializeCookie } from '../../../_lib/http.js';
import { nowSeconds } from '../../../_lib/token.js';

export const googleStartLimiter = createRateLimiter(30, 10 * 60 * 1000);

export function GET(req: Request): Response {
  if (!googleStartLimiter.hit(clientIp(req))) return googleErrorRedirect(req, 'rate_limited');
  if (!googleFromEnv()) return googleErrorRedirect(req, 'disabled');
  const { config, error } = configOrError([], 'html');
  if (error) return error;
  const google = config.google!;
  const next = safeNext(new URL(req.url).searchParams.get('next')) ?? '/';
  const nonce = randomId(24);
  const state = signState(nonce, next, config.signingSecret, nowSeconds());
  const cookie = serializeCookie(GSTATE_COOKIE, nonce, { maxAge: GSTATE_TTL_SECONDS, path: GSTATE_COOKIE_PATH, secure: cookieSecure(req) });
  return redirect(authorizationUrl(google, appBaseUrl(req, config), state, nonce), [cookie]);
}
