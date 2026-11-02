// One-time email login codes: 6 random digits, stored only as an HMAC (SIGNING_SECRET) under otp:{email}.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { normEmail } from './store.js';

export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;
/** Codes per email per rolling hour, and minimum seconds between two sends to the same email. */
export const OTP_MAX_SENDS_PER_HOUR = 5;
export const OTP_MIN_INTERVAL_SECONDS = 30;
export const OTP_SEND_WINDOW_SECONDS = 60 * 60;

/** Uniformly random 6-digit numeric code (leading zeros kept). */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtp(email: string, code: string, secret: string): string {
  return createHmac('sha256', secret).update(`otp:${normEmail(email)}:${code}`).digest('hex');
}

/** Constant-time comparison of a submitted code against the stored hash. */
export function otpMatches(email: string, code: string, storedHash: string, secret: string): boolean {
  const given = Buffer.from(hashOtp(email, code, secret), 'hex');
  const expected = Buffer.from(typeof storedHash === 'string' ? storedHash : '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Normalise user input: strip spaces/dashes; returns the 6 digits or null. Accepts Arabic-Indic digits too. */
export function parseOtpInput(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s-]/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}
