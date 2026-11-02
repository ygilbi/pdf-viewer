// POST /api/auth/request — public "request access" form (also served as the legacy /api/request-access).
// Body: { name, email, company?, message?, website? (honeypot) }.
// Creates/updates user:{email} with status 'pending' and emails the owner signed approve/deny links.
// Already-active users get { ok: true, alreadyActive: true } and no email is sent.
import { getMailer } from '../_lib/mailer.js';
import { daysFromNow, nowSeconds, signToken, APPROVE_TTL_DAYS } from '../_lib/token.js';
import { ownerRequestEmail, requesterAckEmail } from '../_lib/templates.js';
import { validateAccessRequest } from '../_lib/validate.js';
import { appBaseUrl, clientIp, configOrError, createRateLimiter, jsonError, jsonResponse, readJsonBody } from '../_lib/http.js';
import { authError, randomId } from '../_lib/auth.js';
import { getStore, normEmail, type UserRecord } from '../_lib/store.js';

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

  const email = normEmail(v.value.email);
  const store = getStore(config.kv);
  const now = nowSeconds();
  try {
    const existing = await store.getUser(email);
    if (existing?.status === 'active') {
      console.log(`[access] request from already-active ${email} ip=${ip}`);
      return jsonResponse({ ok: true, alreadyActive: true });
    }
    const user: UserRecord = {
      ...existing,
      id: existing?.id ?? randomId(32),
      email,
      name: v.value.name,
      status: 'pending',
      createdAt: existing?.createdAt ?? now,
      approvedAt: null,
    };
    await store.putUser(user);
  } catch (err) {
    console.error('[access] store error on request:', err);
    return authError('store_failed');
  }

  const token = signToken({ t: 'approve', ...v.value, email, iat: now, exp: daysFromNow(APPROVE_TTL_DAYS, now) }, config.signingSecret);
  const base = appBaseUrl(req, config);
  const q = `t=${encodeURIComponent(token)}`;
  const mail = ownerRequestEmail({ ...v.value, email, approveUrl: `${base}/api/approve?${q}`, denyUrl: `${base}/api/deny?${q}` });

  const mailer = getMailer(config.mail);
  try {
    await mailer.send({ to: config.ownerEmail, replyTo: email, ...mail });
  } catch (err) {
    console.error('[access] failed to email owner:', err);
    return jsonError('mail_failed', MAIL_ERROR_TEXT, 502);
  }
  console.log(`[access] request from ${email} ip=${ip}`);

  if (config.sendRequesterAck) {
    try {
      await mailer.send({ to: email, ...requesterAckEmail() });
    } catch (err) {
      // The owner already has the request; a failed acknowledgement is not fatal.
      console.warn('[access] failed to send requester acknowledgement:', err);
    }
  }
  return jsonResponse({ ok: true });
}
