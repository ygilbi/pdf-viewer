/** Hebrew wording for WebAuthn ceremony failures and auth API error codes. */

export type Hint =
  /** Offer the "request access" form. */
  | 'request'
  /** Offer the /api/health diagnostics link. */
  | 'health';

export interface UiError {
  message: string;
  code?: string;
  hints?: Hint[];
}

export const MSG = {
  loginCancelled: 'הכניסה בוטלה.',
  loginNoPasskeyHint:
    'אין במכשיר הזה מפתח גישה? בחלון הכניסה בחר/י "טלפון או טאבלט" וסרוק/י את קוד ה-QR עם הטלפון שבו נרשמת — או בקש/י גישה.',
  registerCancelled: 'הרישום בוטל. לחץ/י שוב כדי לרשום את Face ID / טביעת האצבע.',
  alreadyRegistered: 'המכשיר הזה כבר רשום — היכנס/י עם Face ID / טביעת אצבע.',
  domain: 'כתובת האתר אינה תואמת להגדרות השרת (RP ID / ORIGIN).',
  unsupported: 'המכשיר או הדפדפן אינם תומכים בכניסה ביומטרית מהסוג הזה. נסה/י דפדפן מעודכן (Safari, Chrome, Edge) או הטלפון.',
  generic: 'משהו השתבש. נסה/י שוב.',
} as const;

const CONFIG_CODES = new Set(['server_config', 'mail_failed']);

/** True for API failures about the invite link itself (expired / already used / unknown). */
export function isInviteError(code: string | undefined, status?: number): boolean {
  return status === 410 || (!!code && /invite|expired|used/i.test(code));
}

/** Server `{ ok:false, code, error }` → UI error with hints. */
export function fromApi(r: { code: string; error: string; status?: number }, kind: 'login' | 'register' | 'request'): UiError {
  const hints: Hint[] = [];
  if (CONFIG_CODES.has(r.code)) hints.push('health');
  if (kind === 'register' && isInviteError(r.code, r.status)) hints.push('request');
  if (kind === 'login' && /credential|not_found|not_registered|unknown|not_active|inactive|revoked|pending/i.test(r.code)) hints.push('request');
  return { message: r.error, code: r.code, hints };
}

/** Seconds before "שלח שוב" re-enables after a code was mailed. */
export const RESEND_SECONDS = 30;

/** POST auth/email/verify failure → UI error; `resend` = the code is dead, offer a new one right away. */
export function fromEmailVerify(r: { code: string; error: string; status?: number; attemptsLeft?: number }): UiError & { resend: boolean } {
  if (r.code === 'code_invalid') {
    const n = r.attemptsLeft;
    if (n === 0) return { message: 'הקוד שגוי ונחסם. שלח/י קוד חדש.', code: r.code, resend: true };
    const left = n === undefined ? '' : n === 1 ? ' נותר ניסיון אחד.' : ` נותרו ${n} ניסיונות.`;
    return { message: `הקוד שגוי.${left}`, code: r.code, resend: false };
  }
  if (r.code === 'code_expired' || r.status === 410) return { message: 'תוקף הקוד פג. שלח/י קוד חדש.', code: r.code, resend: true };
  if (r.code === 'too_many_attempts') return { message: 'יותר מדי ניסיונות שגויים. שלח/י קוד חדש.', code: r.code, resend: true };
  return { ...fromApi(r, 'login'), resend: false };
}

/** "0:27" */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Errors thrown by startAuthentication / startRegistration (WebAuthnError or DOMException). */
export function fromWebAuthn(err: unknown, kind: 'login' | 'register'): UiError {
  const e = err as { name?: string; code?: string; message?: string } | null;
  const name = e?.name ?? '';
  const code = e?.code ?? '';
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
    return { message: MSG.alreadyRegistered, code: 'previously_registered' };
  }
  if (code === 'ERROR_CEREMONY_ABORTED' || name === 'NotAllowedError' || name === 'AbortError') {
    return kind === 'login'
      ? { message: `${MSG.loginCancelled} ${MSG.loginNoPasskeyHint}`, code: 'cancelled', hints: ['request'] }
      : { message: MSG.registerCancelled, code: 'cancelled' };
  }
  if (code === 'ERROR_INVALID_DOMAIN' || code === 'ERROR_INVALID_RP_ID' || name === 'SecurityError') {
    return { message: MSG.domain, code: 'domain', hints: ['health'] };
  }
  if (name === 'NotSupportedError' || code.startsWith('ERROR_AUTHENTICATOR_MISSING') || code === 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG') {
    return { message: MSG.unsupported, code: 'unsupported' };
  }
  return { message: MSG.generic + (e?.message ? ` (${e.message})` : ''), code: 'webauthn' };
}
