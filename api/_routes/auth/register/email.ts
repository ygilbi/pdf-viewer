// POST /api/auth/register/email { invite } → { ok, user } + pv_session cookie.
// Completes registration WITHOUT a passkey: the invite link (sent to the requester's address) proves email
// ownership. Validates the invite exactly like register/options, consumes it (single use), activates the user
// and notifies the owner (with the revoke link). Later logins use an email code (or a passkey added later).
import { authError, publicUser, sessionCookie } from '../../../_lib/auth.js';
import { checkInvite } from '../../../_lib/invite.js';
import { clientIp, configOrError, createRateLimiter, jsonWithCookies, readJsonBody } from '../../../_lib/http.js';
import { getStore, type UserRecord } from '../../../_lib/store.js';
import { notifyOwnerRegistered } from '../../../_lib/decision.js';
import { nowSeconds } from '../../../_lib/token.js';

const limiter = createRateLimiter(30, 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  if (!limiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '60' });
  const parsed = await readJsonBody(req, 16 * 1024);
  if (parsed.error) return parsed.error;
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);

  let user: UserRecord;
  try {
    const check = await checkInvite((parsed.body as { invite?: unknown } | null)?.invite, config.signingSecret, store);
    if (!check.ok) return authError(check.code);
    if (!(await store.consumeInvite(check.invite.jti))) return authError('invite_used');
    const now = nowSeconds();
    user = { ...check.user, status: 'active', activatedAt: now };
    await store.putUser(user);
  } catch (err) {
    console.error('[access] register/email store error:', err);
    return authError('store_failed');
  }
  console.log(`[access] registered ${user.email} (email, no passkey)`);

  await notifyOwnerRegistered(req, user, 'email');
  return jsonWithCookies({ ok: true, user: publicUser(user) }, [await sessionCookie(req, config, user)]);
}
