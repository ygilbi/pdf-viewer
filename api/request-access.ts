// POST /api/request-access — public form submission. Emails the owner approve/deny links (signed, stateless).
import { getMailer } from './_lib/mailer.js';
import { daysFromNow, nowSeconds, signToken, APPROVE_TTL_DAYS } from './_lib/token.js';
import { ownerRequestEmail, requesterAckEmail } from './_lib/templates.js';
import { validateAccessRequest } from './_lib/validate.js';
import {
  BodyTooLargeError,
  appBaseUrl,
  clientIp,
  configOrError,
  createRateLimiter,
  jsonResponse,
  readLimitedText,
} from './_lib/http.js';

const MAX_BODY_BYTES = 8 * 1024;
/** 5 requests per IP per 10 minutes, per warm instance (best effort only). */
const rateLimiter = createRateLimiter(5, 10 * 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);
  if (!rateLimiter.hit(ip)) {
    return jsonResponse({ ok: false, error: 'rate_limited', message: 'נשלחו יותר מדי בקשות. נסו שוב בעוד כמה דקות.' }, 429, {
      'Retry-After': '600',
    });
  }

  let raw: string;
  try {
    raw = await readLimitedText(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return jsonResponse({ ok: false, error: 'too_large', message: 'הבקשה גדולה מדי.' }, 413);
    }
    throw err;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ ok: false, error: 'bad_json', message: 'גוף הבקשה אינו JSON תקין.' }, 400);
  }

  // Honeypot: bots fill every field. Pretend success, do nothing.
  const website = (body as { website?: unknown } | null)?.website;
  if (typeof website === 'string' && website.trim() !== '') {
    console.log(`[download-approval] honeypot triggered ip=${ip}`);
    return jsonResponse({ ok: true });
  }

  const v = validateAccessRequest(body);
  if (!v.ok) {
    return jsonResponse({ ok: false, error: 'validation', message: 'יש לתקן את השדות המסומנים.', fields: v.errors }, 400);
  }

  const { config, error } = configOrError(['mail', 'owner'], 'json');
  if (error) return error;

  const iat = nowSeconds();
  const token = signToken(
    { t: 'approve', ...v.value, iat, exp: daysFromNow(APPROVE_TTL_DAYS, iat) },
    config.signingSecret,
  );
  const base = appBaseUrl(req, config);
  const q = `t=${encodeURIComponent(token)}`;
  const mail = ownerRequestEmail({
    ...v.value,
    approveUrl: `${base}/api/approve?${q}`,
    denyUrl: `${base}/api/deny?${q}`,
  });

  const mailer = getMailer(config.mail);
  try {
    await mailer.send({ to: config.ownerEmail, replyTo: v.value.email, ...mail });
  } catch (err) {
    console.error('[download-approval] failed to email owner:', err);
    return jsonResponse({ ok: false, error: 'mail_failed', message: 'שליחת הבקשה נכשלה. נסו שוב מאוחר יותר.' }, 502);
  }
  console.log(`[download-approval] request from ${v.value.email} ip=${ip}`);

  if (config.sendRequesterAck) {
    try {
      await mailer.send({ to: v.value.email, ...requesterAckEmail() });
    } catch (err) {
      // The owner already has the request; a failed acknowledgement is not fatal.
      console.warn('[download-approval] failed to send requester acknowledgement:', err);
    }
  }

  return jsonResponse({ ok: true });
}
