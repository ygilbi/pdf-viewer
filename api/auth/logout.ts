// POST /api/auth/logout → { ok: true } and clears the pv_session cookie.
import { clearSessionCookie } from '../_lib/auth.js';
import { jsonWithCookies } from '../_lib/http.js';

export function POST(req: Request): Response {
  return jsonWithCookies({ ok: true }, [clearSessionCookie(req)]);
}
