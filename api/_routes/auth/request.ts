// POST /api/auth/request — public "request access" form (also served as the legacy /api/request-access).
// Body: { name, email, company?, message?, website? (honeypot) }.
// Creates/updates user:{email} with status 'pending' and emails the owner signed approve/deny links.
// Already-active users get { ok: true, alreadyActive: true } and no email is sent.
import { validateAccessRequest } from '../../_lib/validate.js';
import { clientIp, configOrError, createRateLimiter, jsonError, jsonResponse, readJsonBody } from '../../_lib/http.js';
import { authError } from '../../_lib/auth.js';
import { AccessRequestError, submitAccessRequest, type SubmitStatus } from '../../_lib/access-request.js';
import { getStore, normEmail } from '../../_lib/store.js';

const MAX_BODY_BYTES = 8 * 1024;
/** 5 requests per IP per 10 minutes, per warm instance (best effort only). */
export const requestRateLimiter = createRateLimiter(5, 10 * 60 * 1000);

export const MAIL_ERROR_TEXT =
  'שליחת הבקשה נכשלה (השרת לא הצליח לשלוח מייל). נסו שוב מאוחר יותר. מנהל/ת האתר: פתחו את הכתובת ‎/api/health‏ לאבחון.';

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);
  if (!requestRateLimiter.hit(ip)) {
    return jsonError('rate_limited', 'נשלחו יותר מדי בקשות. נסו שוב בעוד כמה דקות.', 429, {}, { 'Retry-After': '600' });
  }

  const parsed = await readJsonBody(req, MAX_BODY_BYTES);
  if (parsed.error) return parsed.error;
  const body = parsed.body;

  // Honeypot: bots fill every field. Pretend success, do nothing.
  const website = (body as { website?: unknown } | null)?.website;
  if (typeof website === 'string' && website.trim() !== '') {
    console.log(`[access] honeypot triggered ip=${ip}`);
    return jsonResponse({ ok: true });
  }

  const v = validateAccessRequest(body);
  if (!v.ok) return jsonError('validation', 'יש לתקן את השדות המסומנים.', 400, { fields: v.errors });

  const { config, error } = configOrError(['mail', 'owner', 'kv'], 'json');
  if (error) return error;

  const store = getStore(config.kv);
  let status: SubmitStatus;
  try {
    status = await submitAccessRequest(req, config, store, v.value);
  } catch (err) {
    if (!(err instanceof AccessRequestError)) throw err;
    return err.code === 'mail_failed' ? jsonError('mail_failed', MAIL_ERROR_TEXT, 502) : authError('store_failed');
  }
  const email = normEmail(v.value.email);
  if (status === 'already_active') {
    console.log(`[access] request from already-active ${email} ip=${ip}`);
    return jsonResponse({ ok: true, alreadyActive: true });
  }
  console.log(`[access] request from ${email} ip=${ip}`);
  return jsonResponse({ ok: true });
}
