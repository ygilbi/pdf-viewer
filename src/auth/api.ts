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
}

export type ApiFailure = { ok: false; code: string; error: string; status: number };
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
    const d = data as { ok: unknown; code?: unknown; error?: unknown };
    if (d.ok === true && res.ok) return data as { ok: true } & T;
    if (d.ok === false || !res.ok) {
      return {
        ok: false,
        code: typeof d.code === 'string' && d.code ? d.code : res.status === 401 ? 'unauthorized' : 'error',
        error: typeof d.error === 'string' && d.error ? d.error : statusError(res.status),
        status: res.status,
      };
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

// ---------------------------------------------------------------- endpoints

export const requestAccess = (input: { name: string; email: string; website?: string }, o?: RequestOpts) =>
  apiRequest<{ alreadyActive?: boolean }>('POST', 'auth/request', input, o);

export const registerOptions = (invite: string, o?: RequestOpts) =>
  apiRequest<{ options: PublicKeyCredentialCreationOptionsJSON; user: AuthUser }>('POST', 'auth/register/options', { invite }, o);

export const registerVerify = (invite: string, response: RegistrationResponseJSON, o?: RequestOpts) =>
  apiRequest<{ user: AuthUser }>('POST', 'auth/register/verify', { invite, response }, o);

export const loginOptions = (o?: RequestOpts) =>
  apiRequest<{ options: PublicKeyCredentialRequestOptionsJSON }>('POST', 'auth/login/options', {}, o);

export const loginVerify = (response: AuthenticationResponseJSON, o?: RequestOpts) =>
  apiRequest<{ user: AuthUser }>('POST', 'auth/login/verify', { response }, o);

export const logout = (o?: RequestOpts) => apiRequest('POST', 'auth/logout', {}, o);

export type MeState =
  | { state: 'signed-in'; user: AuthUser }
  | { state: 'signed-out' }
  /** Offline, timeout, server error, no API on this host: let the app run (the server middleware still protects). */
  | { state: 'unknown' };

export async function getMe(o?: RequestOpts): Promise<MeState> {
  const r = await apiRequest<{ user: AuthUser }>('GET', 'auth/me', undefined, { timeoutMs: 6000, ...o });
  if (r.ok) return r.user ? { state: 'signed-in', user: r.user } : { state: 'unknown' };
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

/** `/login?next=<current path>` (the gate's redirect target). */
export function loginUrl(next: string): string {
  return `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}
