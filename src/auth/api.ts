/**
 * Thin fetch wrappers for the passkey auth backend (api/auth/*).
 *
 * Contract: every endpoint answers JSON `{ ok: true, ... }` or `{ ok: false, code, error }`
 * (Hebrew `error`). Network failures, timeouts and non-JSON answers are folded into the
 * same `{ ok: false }` shape (codes `network` / `timeout` / `bad_response`) so callers
 * only ever branch on `ok`.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

export interface AuthUser {
  name: string;
  email: string;
  /** From GET auth/me: whether the account has at least one passkey (absent on older backends). */
  hasPasskey?: boolean;
}

export type ApiFailure = {
  ok: false;
  code: string;
  error: string;
  status: number;
  /** Seconds until a new e-mail code may be requested (429 too_soon). */
  retryAfter?: number;
  /** Code guesses left before the code is burned (400 code_invalid). */
  attemptsLeft?: number;
};
export type ApiResult<T extends object = object> = ({ ok: true } & T) | ApiFailure;

const BASE: string = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
export const API_BASE = `${BASE}api/`;
export const LOGIN_PATH = `${BASE}login`;
export const HEALTH_URL = `${API_BASE}health`;

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Server error codes that mean "the owner must fix the deployment" (show the /api/health hint). */
export const CONFIG_ERROR_CODES: ReadonlySet<string> = new Set(['server_config', 'mail_failed']);

const NETWORK_ERROR = 'אין חיבור לשרת. בדוק/י את החיבור לאינטרנט ונסה/י שוב.';
const TIMEOUT_ERROR = 'השרת לא הגיב בזמן. נסה/י שוב בעוד רגע.';

function statusError(status: number): string {
  if (status === 401) return 'נדרשת כניסה מחדש.';
  if (status === 404) return 'שירות הכניסה אינו זמין בכתובת זו.';
  if (status === 429) return 'יותר מדי ניסיונות. נסה/י שוב בעוד כמה דקות.';
  if (status >= 500) return 'שגיאת שרת. נסה/י שוב מאוחר יותר.';
  return `הבקשה נכשלה (${status}).`;
}

export interface RequestOpts {
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** POST/GET JSON to `api/<path>`; never throws. */
export async function apiRequest<T extends object = object>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl }: RequestOpts = {},
): Promise<ApiResult<T>> {
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  let res: Response;
  try {
    res = await doFetch(API_BASE + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    return timedOut
      ? { ok: false, code: 'timeout', error: TIMEOUT_ERROR, status: 0 }
      : { ok: false, code: 'network', error: NETWORK_ERROR, status: 0 };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  } finally {
    clearTimeout(timer);
  }
  if (data && typeof data === 'object' && 'ok' in data) {
    const d = data as { ok: unknown; code?: unknown; error?: unknown; retryAfter?: unknown; attemptsLeft?: unknown };
    if (d.ok === true && res.ok) return data as { ok: true } & T;
    if (d.ok === false || !res.ok) {
      const fail: ApiFailure = {
        ok: false,
        code: typeof d.code === 'string' && d.code ? d.code : res.status === 401 ? 'unauthorized' : 'error',
        error: typeof d.error === 'string' && d.error ? d.error : statusError(res.status),
        status: res.status,
      };
      const retryAfter = numberOrNull(d.retryAfter) ?? numberOrNull(res.headers?.get?.('Retry-After'));
      if (retryAfter !== null && retryAfter >= 0) fail.retryAfter = Math.ceil(retryAfter);
      const attemptsLeft = numberOrNull(d.attemptsLeft);
      if (attemptsLeft !== null && attemptsLeft >= 0) fail.attemptsLeft = Math.floor(attemptsLeft);
      return fail;
    }
  }
  if (timedOut) return { ok: false, code: 'timeout', error: TIMEOUT_ERROR, status: 0 };
  return {
    ok: false,
    code: res.status === 401 ? 'unauthorized' : 'bad_response',
    error: statusError(res.status),
    status: res.status,
  };
}

function numberOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- endpoints

export const requestAccess = (input: { name: string; email: string; website?: string }, o?: RequestOpts) =>
  apiRequest<{ alreadyActive?: boolean }>('POST', 'auth/request', input, o);

export const registerOptions = (invite: string, o?: RequestOpts) =>
  apiRequest<{ options: PublicKeyCredentialCreationOptionsJSON; user: AuthUser }>('POST', 'auth/register/options', { invite }, o);

/** Platform-only registration (400 not_platform when a phone / security key was used); returns the new credential id. */
export const registerVerify = (invite: string, response: RegistrationResponseJSON, o?: RequestOpts) =>
  apiRequest<{ user: AuthUser; credentialId?: string }>('POST', 'auth/register/verify', { invite, response }, o);

/**
 * With `credentialIds` (the passkeys this device created, see deviceKeys.ts) the options carry
 * allowCredentials (transport internal) + hints ['client-device'] → straight to Face ID / Touch ID /
 * Windows Hello, never the cross-device (QR) chooser.
 */
export const loginOptions = (credentialIds?: readonly string[], o?: RequestOpts) =>
  apiRequest<{ options: PublicKeyCredentialRequestOptionsJSON }>(
    'POST',
    'auth/login/options',
    credentialIds && credentialIds.length ? { credentialIds: [...credentialIds] } : {},
    o,
  );

/** 401 unknown_credential (Hebrew error) when the passkey is no longer on any account. */
export const loginVerify = (response: AuthenticationResponseJSON, o?: RequestOpts) =>
  apiRequest<{ user: AuthUser; credentialId?: string }>('POST', 'auth/login/verify', { response }, o);

/** Which of these credential ids the server still knows (stale local entries are dropped). */
export const passkeyStatus = (credentialIds: readonly string[], o?: RequestOpts) =>
  apiRequest<{ known: string[] }>('POST', 'auth/passkey/status', { credentialIds: [...credentialIds] }, { timeoutMs: 6000, ...o });

export const logout = (o?: RequestOpts) => apiRequest('POST', 'auth/logout', {}, o);

/** Sign-in by one-time e-mail code, step 1: mail a 6-digit code (404 not_registered, 429 rate_limited / too_soon {retryAfter}). */
export const emailStart = (email: string, o?: RequestOpts) =>
  apiRequest<{ sent: boolean }>('POST', 'auth/email/start', { email }, o);

/** Step 2: check the code; sets the session cookie (400 code_invalid {attemptsLeft}, 410 code_expired, 429 too_many_attempts). */
export const emailVerify = (email: string, code: string, o?: RequestOpts) =>
  apiRequest<{ user: AuthUser }>('POST', 'auth/email/verify', { email, code }, o);

/** Invite registration without a passkey (later sign-ins by e-mail code); sets the session cookie. */
export const registerEmail = (invite: string, o?: RequestOpts) =>
  apiRequest<{ user: AuthUser }>('POST', 'auth/register/email', { invite }, o);

/** Add a passkey to the signed-in account (401 when signed out). */
export const passkeyAddOptions = (o?: RequestOpts) =>
  apiRequest<{ options: PublicKeyCredentialCreationOptionsJSON }>('POST', 'auth/passkey/add/options', {}, o);

export const passkeyAddVerify = (response: RegistrationResponseJSON, o?: RequestOpts) =>
  apiRequest<{ user?: AuthUser; credentialId?: string }>('POST', 'auth/passkey/add/verify', { response }, o);

export type MeState =
  | { state: 'signed-in'; user: AuthUser }
  | { state: 'signed-out' }
  /** Offline, timeout, server error, no API on this host: let the app run (the server middleware still protects). */
  | { state: 'unknown' };

export async function getMe(o?: RequestOpts): Promise<MeState> {
  const r = await apiRequest<{ user: AuthUser; hasPasskey?: boolean }>('GET', 'auth/me', undefined, { timeoutMs: 6000, ...o });
  if (r.ok) {
    if (!r.user) return { state: 'unknown' };
    // `hasPasskey` may sit next to `user` or inside it.
    const hasPasskey = typeof r.user.hasPasskey === 'boolean' ? r.user.hasPasskey : typeof r.hasPasskey === 'boolean' ? r.hasPasskey : undefined;
    return { state: 'signed-in', user: hasPasskey === undefined ? r.user : { ...r.user, hasPasskey } };
  }
  if (r.status === 401) return { state: 'signed-out' };
  return { state: 'unknown' };
}

// ---------------------------------------------------------------- redirects

/**
 * Open-redirect guard for `?next=`: only same-origin, root-relative paths survive
 * (`/x?y#z`); anything else (absolute / protocol-relative / backslash tricks / control
 * chars / javascript:) yields `fallback`. Never sends the user back to the login page.
 */
export function safeNext(raw: string | null | undefined, fallback = '/'): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return fallback;
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, 'https://origin.invalid');
  } catch {
    return fallback;
  }
  if (url.origin !== 'https://origin.invalid') return fallback;
  if (/^\/login(\.html)?\/?$/i.test(url.pathname)) return fallback;
  return url.pathname + url.search + url.hash;
}

/** Landing page right after a successful registration (install / default-app / Windows download). */
export const WELCOME_PATH = `${BASE}welcome`;

/** `/login?next=<current path>` (the gate's redirect target). */
export function loginUrl(next: string): string {
  return `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

// ---------------------------------------------------------------- providers / invite status / Google

export interface AuthProviders {
  google: boolean;
  passkey: boolean;
  emailCode: boolean;
}

/** GET auth/providers. Never throws; when unknown (old backend / offline) Google is hidden, the rest stays on. */
export async function getProviders(o?: RequestOpts): Promise<AuthProviders> {
  const r = await apiRequest<Partial<AuthProviders>>('GET', 'auth/providers', undefined, { timeoutMs: 6000, ...o });
  if (!r.ok) return { google: false, passkey: true, emailCode: true };
  return { google: r.google === true, passkey: r.passkey !== false, emailCode: r.emailCode !== false };
}

export interface InviteStatus {
  email: string;
  name: string;
  /** User status behind the invite; 'active' = already registered (sign in instead of registering). */
  status: string;
}

/** GET auth/invite-status?invite=… (410 / 400 for expired / used / unknown invites). */
export const inviteStatus = (invite: string, o?: RequestOpts) =>
  apiRequest<InviteStatus>('GET', `auth/invite-status?invite=${encodeURIComponent(invite)}`, undefined, o);

/** Full-page navigation target for "continue with Google"; `next` passes the open-redirect guard (default `/`). */
export function googleStartUrl(next: string | null | undefined): string {
  return `${API_BASE}auth/google/start?next=${encodeURIComponent(safeNext(next, BASE))}`;
}

/**
 * Google round trip that comes back to /login?after=google&next=<next> (instead of straight to `next`),
 * so /login can offer "enable quick sign-in with Face ID on this device" before continuing.
 */
export function googleStartUrlViaLogin(next: string | null | undefined): string {
  const back = `${LOGIN_PATH}?after=google&next=${encodeURIComponent(safeNext(next, BASE))}`;
  return `${API_BASE}auth/google/start?next=${encodeURIComponent(back)}`;
}
