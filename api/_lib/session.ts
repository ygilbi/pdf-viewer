// Session cookie (pv_session) signing/verification with Web Crypto only, so the same code runs in the
// Node functions and in the Edge routing middleware (middleware.ts). No node:* imports here.
// Format matches token.ts: base64url(JSON payload) + "." + base64url(HMAC-SHA256).

export const SESSION_COOKIE = 'pv_session';
export const CHALLENGE_COOKIE = 'pv_chal';

export interface SessionPayload {
  t: 'session';
  /** Normalised (lower-case) email. */
  sub: string;
  iat: number;
  exp: number;
  /** User's session epoch at issue time; bumping user.sessionEpoch (on revoke) kills older sessions. */
  ep: number;
}

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(
  sub: string,
  days: number,
  secret: string,
  epoch = 0,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: SessionPayload = { t: 'session', sub, iat: now, exp: now + Math.round(days * 86400), ep: epoch };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

/** Returns the payload of a valid, unexpired session token, else null. Constant-time via crypto.subtle.verify. */
export async function verifySession(
  token: string | null | undefined,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  if (!token || token.length > 4096 || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]) || !/^[\w-]+$/.test(parts[1])) return null;
  try {
    const sig = b64urlDecode(parts[1]);
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig as Uint8Array<ArrayBuffer>, enc.encode(parts[0]));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as Partial<SessionPayload>;
    if (p?.t !== 'session' || typeof p.sub !== 'string' || typeof p.exp !== 'number' || typeof p.iat !== 'number') return null;
    if (p.ep !== undefined && typeof p.ep !== 'number') return null;
    if (p.exp <= now) return null;
    return { ...(p as SessionPayload), ep: p.ep ?? 0 };
  } catch {
    return null;
  }
}

export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

/** Minimal shape of user:{email} needed to decide whether a session is still valid. */
export interface SessionUser {
  status: string;
  /** Incremented on revoke; only sessions carrying the current epoch are valid. */
  sessionEpoch?: number;
}

export function sessionUserValid(user: SessionUser | null, session: SessionPayload): boolean {
  if (!user || user.status !== 'active') return false;
  return (session.ep ?? 0) === (user.sessionEpoch ?? 0);
}
