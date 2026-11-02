/** Last e-mail used for code sign-in, remembered per browser (best effort: storage may be blocked). */
export const LAST_EMAIL_KEY = 'pdf-viewer:last-email';

export function loadLastEmail(): string {
  try {
    return globalThis.localStorage?.getItem(LAST_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveLastEmail(email: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_EMAIL_KEY, email);
  } catch {
    /* private mode / blocked storage */
  }
}
