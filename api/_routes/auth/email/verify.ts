// POST /api/auth/email/verify { email, code } → { ok: true, user } + pv_session cookie.
// Errors: code_expired 410 (no code / expired), code_invalid 400 { attemptsLeft }, too_many_attempts 429
// (after 5 wrong codes; the code is deleted), not_active 403. Attempts are counted atomically in Redis.
import { authError, publicUser, sessionCookie } from '../../../_lib/auth.js';
import { clientIp, configOrError, createRateLimiter, jsonWithCookies, readJsonBody } from '../../../_lib/http.js';
import { OTP_MAX_ATTEMPTS, otpMatches, parseOtpInput } from '../../../_lib/otp.js';
import { getStore, normEmail, type OtpRecord, type UserRecord } from '../../../_lib/store.js';
import { nowSeconds } from '../../../_lib/token.js';
import { isValidEmail } from '../../../_lib/validate.js';

/** Best-effort per-IP limit (per warm instance); the real guard is the per-code attempt counter. */
export const emailVerifyIpLimiter = createRateLimiter(30, 10 * 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  if (!emailVerifyIpLimiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '600' }, { retryAfter: 600 });
  const parsed = await readJsonBody(req, 4 * 1024);
  if (parsed.error) return parsed.error;
  const body = (parsed.body ?? {}) as { email?: unknown; code?: unknown };
  if (!isValidEmail(body.email)) return authError('bad_request', {}, { error: 'יש להזין כתובת אימייל תקינה.' });
  const email = normEmail(body.email);
  const code = parseOtpInput(body.code);

  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);
  const now = nowSeconds();

  let otp: OtpRecord | null;
  try {
    otp = await store.getOtp(email);
    if (!otp || typeof otp.hash !== 'string' || typeof otp.exp !== 'number') return authError('code_expired');
    if (otp.exp <= now) {
      await store.deleteOtp(email);
      return authError('code_expired');
    }
    const attempt = await store.countOtpAttempt(email, Math.max(1, otp.exp - now));
    if (attempt > OTP_MAX_ATTEMPTS) {
      await store.deleteOtp(email);
      return authError('too_many_attempts');
    }
    if (!code || !otpMatches(email, code, otp.hash, config.signingSecret)) {
      const attemptsLeft = OTP_MAX_ATTEMPTS - attempt;
      if (attemptsLeft <= 0) {
        await store.deleteOtp(email);
        return authError('too_many_attempts');
      }
      console.log(`[access] wrong email code for ${email} ip=${clientIp(req)} (${attemptsLeft} left)`);
      return authError('code_invalid', {}, { attemptsLeft, error: `הקוד שגוי. נותרו ${attemptsLeft} ניסיונות.` });
    }
    await store.deleteOtp(email);
  } catch (err) {
    console.error('[access] email/verify store error:', err);
    return authError('store_failed');
  }

  let user: UserRecord | null;
  try {
    user = await store.getUser(email);
  } catch (err) {
    console.error('[access] email/verify store error:', err);
    return authError('store_failed');
  }
  if (!user || user.status !== 'active') return authError('not_active');
  console.log(`[access] login (email code) ${email}`);
  return jsonWithCookies({ ok: true, user: publicUser(user) }, [await sessionCookie(req, config, user)]);
}

