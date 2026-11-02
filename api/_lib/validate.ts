// Validation of the public download-request form.

export interface AccessRequest {
  name: string;
  email: string;
  company?: string;
  message?: string;
}

export type FieldErrors = Partial<Record<keyof AccessRequest, string>>;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]{2,}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function validateAccessRequest(
  body: unknown,
): { ok: true; value: AccessRequest } | { ok: false; errors: FieldErrors } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = asString(b.name);
  const email = asString(b.email);
  const company = asString(b.company);
  const message = asString(b.message).replace(/\r\n/g, '\n');
  const errors: FieldErrors = {};

  if ([...name].length < 2 || [...name].length > 80) errors.name = 'יש להזין שם באורך 2–80 תווים.';
  else if (CONTROL_RE.test(name)) errors.name = 'השם מכיל תווים לא חוקיים.';

  if (!email || email.length > 200 || CONTROL_RE.test(email) || !EMAIL_RE.test(email)) {
    errors.email = 'יש להזין כתובת אימייל תקינה.';
  }

  if ([...company].length > 120) errors.company = 'שם החברה ארוך מדי (עד 120 תווים).';
  else if (CONTROL_RE.test(company)) errors.company = 'שם החברה מכיל תווים לא חוקיים.';

  if ([...message].length > 1000) errors.message = 'ההודעה ארוכה מדי (עד 1000 תווים).';
  else if (CONTROL_EXCEPT_NEWLINE_RE.test(message)) errors.message = 'ההודעה מכילה תווים לא חוקיים.';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: { name, email, ...(company ? { company } : {}), ...(message ? { message } : {}) },
  };
}
