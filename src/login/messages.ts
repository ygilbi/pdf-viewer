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
  if (kind === 'login' && /credential|not_found|unknown|not_active|inactive|revoked|pending/i.test(r.code)) hints.push('request');
  return { message: r.error, code: r.code, hints };
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
