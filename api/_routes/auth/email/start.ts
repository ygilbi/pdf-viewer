// POST /api/auth/email/start { email } → { ok: true, sent: true }
// Emails a 6-digit login code to an 'active' user. The code is stored only as an HMAC under otp:{email}
// (10 min, overwrites any previous code). Limits: 5 codes per email per hour and 30 s between sends
// (both in Redis), plus a best-effort per-IP limit in memory.
import { authError } from '../../../_lib/auth.js';
import { clientIp, configOrError, createRateLimiter, jsonResponse, readJsonBody } from '../../../_lib/http.js';
import { getMailer } from '../../../_lib/mailer.js';
import {
  OTP_MAX_SENDS_PER_HOUR,
  OTP_MIN_INTERVAL_SECONDS,
  OTP_SEND_WINDOW_SECONDS,
  OTP_TTL_SECONDS,
  generateOtp,
  hashOtp,
} from '../../../_lib/otp.js';
import { getStore, normEmail } from '../../../_lib/store.js';
import { loginCodeEmail } from '../../../_lib/templates.js';
import { nowSeconds } from '../../../_lib/token.js';
import { isValidEmail } from '../../../_lib/validate.js';

/** 10 code requests per IP per 10 minutes, per warm instance (best effort only). */
export const emailStartIpLimiter = createRateLimiter(10, 10 * 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  if (!emailStartIpLimiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '600' }, { retryAfter: 600 });
  const parsed = await readJsonBody(req, 4 * 1024);
  if (parsed.error) return parsed.error;
  const raw = (parsed.body as { email?: unknown } | null)?.email;
  if (!isValidEmail(raw)) return authError('bad_request', {}, { error: 'יש להזין כתובת אימייל תקינה.' });
  const email = normEmail(raw);

  const { config, error } = configOrError(['mail', 'kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);
  const now = nowSeconds();

  let sends: number[];
  try {
    const user = await store.getUser(email);
    if (!user || user.status !== 'active') {
      console.log(`[access] email code requested for unregistered ${email}`);
      return authError('not_registered');
    }
    sends = (await store.getOtpSends(email)).filter((t) => now - t < OTP_SEND_WINDOW_SECONDS).sort((a, b) => a - b);
  } catch (err) {
    console.error('[access] email/start store error:', err);
    return authError('store_failed');
  }

  const last = sends[sends.length - 1];
  if (last !== undefined && now - last < OTP_MIN_INTERVAL_SECONDS) {
    const retryAfter = OTP_MIN_INTERVAL_SECONDS - (now - last);
    return authError('too_soon', { 'Retry-After': String(retryAfter) }, { retryAfter, error: `קוד נשלח זה עתה. אפשר לבקש קוד חדש בעוד ${retryAfter} שניות.` });
  }
  if (sends.length >= OTP_MAX_SENDS_PER_HOUR) {
    const retryAfter = Math.max(1, OTP_SEND_WINDOW_SECONDS - (now - sends[0]));
    const minutes = Math.ceil(retryAfter / 60);
    return authError(
      'rate_limited',
      { 'Retry-After': String(retryAfter) },
      { retryAfter, error: `נשלחו יותר מדי קודים לכתובת הזו. נסו שוב בעוד ${minutes} דקות.` },
    );
  }

  const code = generateOtp();
  try {
    await store.putOtpSends(email, [...sends, now], OTP_SEND_WINDOW_SECONDS);
    await store.putOtp(email, { hash: hashOtp(email, code, config.signingSecret), exp: now + OTP_TTL_SECONDS, attempts: 0 }, OTP_TTL_SECONDS);
  } catch (err) {
    console.error('[access] email/start store error:', err);
    return authError('store_failed');
  }

  try {
    await getMailer(config.mail).send({ to: email, ...loginCodeEmail({ code, minutes: OTP_TTL_SECONDS / 60 }) });
  } catch (err) {
    console.error('[access] failed to send login code:', err);
    // Nothing was delivered: drop the code and give the send slot back so the user can retry right away.
    try {
      await store.deleteOtp(email);
      await store.putOtpSends(email, sends, OTP_SEND_WINDOW_SECONDS);
    } catch {
      /* ignore */
    }
    return authError('mail_failed');
  }
  console.log(`[access] email code sent to ${email} ip=${clientIp(req)}`);
  return jsonResponse({ ok: true, sent: true });
}
