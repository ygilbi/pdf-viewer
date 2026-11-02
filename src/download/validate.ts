/** Client-side validation for the download request form (mirrors api/request-access). */

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
