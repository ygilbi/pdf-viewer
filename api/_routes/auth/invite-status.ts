// GET /api/auth/invite-status?invite=<token> → { ok: true, email, name, status, expired, used }
// Lets the login page explain a reused registration link ("you're already registered as <email>").
// The invite's signature must be valid (expiry is NOT enforced and the jti need not be unused); the answer only
// concerns that invite's own email/name and the current status of that user:
//   status: 'pending' | 'approved' | 'active' | 'denied' | 'revoked' | 'unknown' (no user record)
//   expired: the invite's exp has passed; used: its one-time jti is gone (consumed, voided or expired in Redis).
// Errors: invite_invalid 410 (bad signature / malformed), rate_limited 429, store_failed 502.
import { authError } from '../../_lib/auth.js';
import { clientIp, configOrError, createRateLimiter, jsonResponse } from '../../_lib/http.js';
import { getStore } from '../../_lib/store.js';
import { nowSeconds, verifyToken } from '../../_lib/token.js';

export const inviteStatusLimiter = createRateLimiter(30, 60 * 1000);

export async function GET(req: Request): Promise<Response> {
  if (!inviteStatusLimiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '60' });
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const token = new URL(req.url).searchParams.get('invite');
  // now = 0: check signature/type/shape only; expiry is reported, not enforced.
  const v = verifyToken(token, config.signingSecret, 'invite', 0);
  if (!v.ok || typeof v.payload.jti !== 'string' || !v.payload.jti) return authError('invite_invalid');
  const { email, name, jti, exp } = v.payload;
  try {
    const store = getStore(config.kv);
    const [user, unused] = await Promise.all([store.getUser(email), store.inviteExists(jti)]);
    return jsonResponse({ ok: true, email, name, status: user?.status ?? 'unknown', expired: exp <= nowSeconds(), used: !unused });
  } catch (err) {
    console.error('[access] invite-status store error:', err);
    return authError('store_failed');
  }
}
