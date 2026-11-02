// Passkey (WebAuthn) + session helpers shared by the api/auth/* functions.
import type { Config } from './config.js';
import { cookieSecure, isLocalHost, requestHost, serializeCookie } from './http.js';
import { CHALLENGE_COOKIE, SESSION_COOKIE, readCookie, sessionUserValid, signSession, verifySession } from './session.js';
import { normEmail, type Store, type UserRecord } from './store.js';

export const RP_NAME = 'PDF Viewer';

export interface RpInfo {
  rpId: string;
  /** Origins accepted in clientDataJSON. */
  origins: string[];
}

/**
 * RP ID = RP_ID, else hostname of APP_URL, else the request host. Expected origin = https://<rpId>;
 * for rpId "localhost" any http(s)://localhost:<port> origin of the request is accepted (local dev).
 */
export function rpInfo(req: Request, config: Config): RpInfo {
  const rpId = config.rpId ?? (config.appUrl ? new URL(config.appUrl).hostname.toLowerCase() : requestHost(req));
  if (isLocalHost(rpId)) {
    const origin = req.headers.get('origin') ?? '';
    const origins = ['http://localhost', 'https://localhost'];
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin)) origins.push(origin);
    return { rpId, origins };
  }
  return { rpId, origins: [`https://${rpId}`] };
}

export function publicUser(u: UserRecord): { name: string; email: string } {
  return { name: u.name, email: u.email };
}

export async function sessionCookie(req: Request, config: Config, user: UserRecord): Promise<string> {
  const token = await signSession(normEmail(user.email), config.sessionDays, config.signingSecret, user.sessionEpoch ?? 0);
  return serializeCookie(SESSION_COOKIE, token, { maxAge: config.sessionDays * 86400, secure: cookieSecure(req) });
}

export function clearSessionCookie(req: Request): string {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: cookieSecure(req) });
}

export const CHALLENGE_COOKIE_PATH = '/api/auth';

export function challengeCookie(req: Request, id: string, maxAge: number): string {
  return serializeCookie(CHALLENGE_COOKIE, id, { maxAge, path: CHALLENGE_COOKIE_PATH, secure: cookieSecure(req) });
}

export function readChallengeCookie(req: Request): string | null {
  const v = readCookie(req.headers.get('cookie'), CHALLENGE_COOKIE);
  return v && /^[\w-]{16,64}$/.test(v) ? v : null;
}

/** The active user behind the request's pv_session cookie, or null (missing/invalid/expired/revoked). */
export async function currentUser(req: Request, config: Config, store: Store): Promise<UserRecord | null> {
  const session = await verifySession(readCookie(req.headers.get('cookie'), SESSION_COOKIE), config.signingSecret);
  if (!session) return null;
  const user = await store.getUser(session.sub);
  return user && sessionUserValid(user, session) ? user : null;
}

export function randomId(bytes = 18): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString('base64url');
}

/** Minimal structural check before handing a client payload to @simplewebauthn/server. */
export function looksLikeCredentialJson(v: unknown): v is { id: string; rawId: string; type: string; response: Record<string, unknown> } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    /^[\w-]{1,1024}$/.test(o.id) &&
    typeof o.rawId === 'string' &&
    o.type === 'public-key' &&
    !!o.response &&
    typeof o.response === 'object'
  );
}

/** Error codes of the api/auth/* endpoints → HTTP status + Hebrew message for display. */
export const AUTH_ERRORS = {
  bad_request: [400, 'הבקשה אינה תקינה.'],
  invite_invalid: [400, 'קישור ההרשמה אינו תקין (ייתכן שהועתק חלקית).'],
  invite_expired: [410, 'תוקף קישור ההרשמה פג. אפשר לבקש גישה מחדש.'],
  invite_used: [410, 'קישור ההרשמה כבר נוצל. אם כבר נרשמתם — התחברו עם מפתח הגישה; אחרת בקשו גישה מחדש.'],
  not_approved: [403, 'הבקשה אינה מאושרת כרגע. אפשר לבקש גישה מחדש.'],
  challenge_expired: [400, 'פג הזמן לאימות. נסו שוב.'],
  verification_failed: [400, 'האימות נכשל. נסו שוב.'],
  credential_exists: [409, 'מפתח הגישה הזה כבר רשום.'],
  unknown_credential: [401, 'מפתח הגישה אינו מוכר (ייתכן שהגישה בוטלה). אפשר לבקש גישה מחדש.'],
  not_active: [403, 'הגישה שלך אינה פעילה. אפשר לבקש גישה מחדש.'],
  unauthenticated: [401, 'יש להתחבר עם מפתח הגישה.'],
  rate_limited: [429, 'יותר מדי ניסיונות. נסו שוב בעוד דקה.'],
  store_failed: [502, 'שגיאה בחיבור למסד הנתונים. מנהל/ת האתר: פתחו את הכתובת ‎/api/health‏ לאבחון.'],
} as const satisfies Record<string, readonly [number, string]>;

export type AuthErrorCode = keyof typeof AUTH_ERRORS;

export function authError(code: AuthErrorCode, headers: Record<string, string> = {}): Response {
  const [status, error] = AUTH_ERRORS[code];
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
