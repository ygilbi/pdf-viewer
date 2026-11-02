/** Client-side validation for the access request form on /login (mirrors the backend request validation). */

export interface AccessRequest {
  name: string;
  email: string;
  company?: string;
  message?: string;
  /** Honeypot — must stay empty. */
  website?: string;
}

export type FieldErrors = Partial<Record<'name' | 'email' | 'company' | 'message', string>>;

export const NAME_MIN = 2;
export const NAME_MAX = 80;
export const EMAIL_MAX = 200;
export const COMPANY_MAX = 120;
export const MESSAGE_MAX = 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return email.length <= EMAIL_MAX && EMAIL_RE.test(email);
}

/** Trims all fields; returns the normalized payload and per-field Hebrew errors. */
export function validateRequest(input: AccessRequest): { data: AccessRequest; errors: FieldErrors } {
  const data: AccessRequest = {
    name: input.name.trim().replace(/\s+/g, ' '),
    email: input.email.trim(),
    company: (input.company ?? '').trim(),
    message: (input.message ?? '').trim(),
    website: input.website ?? '',
  };
  const errors: FieldErrors = {};
  if (!data.name) errors.name = 'נא למלא שם מלא';
  else if (data.name.length < NAME_MIN || data.name.length > NAME_MAX) errors.name = `השם צריך להכיל ${NAME_MIN}–${NAME_MAX} תווים`;
  if (!data.email) errors.email = 'נא למלא כתובת אימייל';
  else if (!isValidEmail(data.email)) errors.email = 'כתובת האימייל אינה תקינה';
  if ((data.company ?? '').length > COMPANY_MAX) errors.company = `עד ${COMPANY_MAX} תווים`;
  if ((data.message ?? '').length > MESSAGE_MAX) errors.message = `עד ${MESSAGE_MAX} תווים`;
  return { data, errors };
}

/** Length of the one-time sign-in code mailed by POST auth/email/start. */
export const CODE_LENGTH = 6;

/**
 * Typed / pasted / autofilled code → digits only, at most CODE_LENGTH.
 * Accepts "123 456", "123-456", full-width / Arabic-Indic digits, and a pasted
 * sentence that contains the code ("הקוד שלך: 123456").
 */
export function normalizeCode(raw: string): string {
  const ascii = raw.replace(/[٠-٩۰-۹０-９]/g, (ch) => {
    const c = ch.charCodeAt(0);
    const zero = c >= 0xff10 ? 0xff10 : c >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(c - zero);
  });
  const run = ascii.match(new RegExp(`\\d{${CODE_LENGTH}}`));
  if (run && /\D/.test(ascii.replace(/[\s-]/g, ''))) return run[0]; // the code inside surrounding text
  return ascii.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

/** Trimmed, lower-cased e-mail for the code flow. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
