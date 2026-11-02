// "Sign in with Google": OAuth 2.0 authorization code flow + OpenID Connect ID token verification.
// No SDK: the token exchange is a plain fetch, and the ID token's RS256 signature is verified with node:crypto
// against Google's published JWKS (cached in module memory, honouring Cache-Control max-age).
// Access is still decided by the owner: Google only proves who the user is (see api/_routes/auth/google/*).
import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { GoogleConfig } from './config.js';
import { cookieSecure, serializeCookie } from './http.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** HttpOnly cookie binding the OAuth state to the browser that started the flow. */
export const GSTATE_COOKIE = 'pv_gstate';
export const GSTATE_COOKIE_PATH = '/api/auth/google';
export const GSTATE_TTL_SECONDS = 10 * 60;
/** Allowed clock skew when checking exp / iat. */
const CLOCK_SKEW_SECONDS = 60;
const FETCH_TIMEOUT_MS = 8000;

export const redirectUri = (base: string): string => `${base}/api/auth/google/callback`;

// ---------------------------------------------------------------- next (post-login destination)

/** A same-origin relative path ("/x?y"), else null. Rejects "//host", "/\\host", schemes and control chars. */
export function safeNext(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) return null;
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return null;
  try {
    const u = new URL(v, 'https://x.invalid');
    if (u.origin !== 'https://x.invalid') return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- signed state

export interface GoogleState {
  t: 'gstate';
  nonce: string;
  next: string;
  iat: number;
  exp: number;
}

const stateSig = (body: string, secret: string): Buffer => createHmac('sha256', secret).update(`gstate.${body}`).digest();

export function signState(nonce: string, next: string, secret: string, now: number): string {
  const payload: GoogleState = { t: 'gstate', nonce, next, iat: now, exp: now + GSTATE_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${stateSig(body, secret).toString('base64url')}`;
}

export function verifyState(token: string | null, secret: string, now: number): GoogleState | null {
  if (!token || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]) || !/^[\w-]+$/.test(parts[1])) return null;
  const expected = stateSig(parts[0], secret);
  const given = Buffer.from(parts[1], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Partial<GoogleState>;
    if (p.t !== 'gstate' || typeof p.nonce !== 'string' || typeof p.exp !== 'number' || p.exp <= now) return null;
    return { t: 'gstate', nonce: p.nonce, next: safeNext(p.next) ?? '/', iat: Number(p.iat) || 0, exp: p.exp };
  } catch {
    return null;
  }
}

/** Constant-time string equality. */
export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function authorizationUrl(google: GoogleConfig, base: string, state: string, nonce: string): string {
  const q = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: redirectUri(base),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${q}`;
}

// ---------------------------------------------------------------- token exchange

export class GoogleAuthError extends Error {
  constructor(readonly code: 'exchange' | 'token' | 'unverified') {
    super(code);
    this.name = 'GoogleAuthError';
  }
}

/** Exchange the authorization code for tokens; returns the raw id_token. Throws GoogleAuthError('exchange'). */
export async function exchangeCode(google: GoogleConfig, base: string, code: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: redirectUri(base),
        grant_type: 'authorization_code',
      }).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[access] google token exchange network error:', (err as Error)?.message);
    throw new GoogleAuthError('exchange');
  }
  let body: { id_token?: unknown; error?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!res.ok || typeof body.id_token !== 'string') {
    // Google's error code only (e.g. invalid_grant, invalid_client); never the response body otherwise.
    console.error(`[access] google token exchange failed: HTTP ${res.status} ${typeof body.error === 'string' ? body.error : ''}`);
    throw new GoogleAuthError('exchange');
  }
  return body.id_token;
}

// ---------------------------------------------------------------- JWKS + ID token verification

let jwksCache: { keys: Map<string, KeyObject>; expiresAt: number; fetchedAt: number } | null = null;

/** Test hook. */
export function resetGoogleJwksCache(): void {
  jwksCache = null;
}

async function fetchJwks(nowMs: number): Promise<Map<string, KeyObject>> {
  const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`jwks HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  const keys = new Map<string, KeyObject>();
  for (const k of Array.isArray(body.keys) ? body.keys : []) {
    const jwk = k as JsonWebKey & { kid?: unknown; alg?: unknown; use?: unknown };
    if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
    } catch {
      /* skip malformed key */
    }
  }
  const maxAge = Number(/max-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  jwksCache = { keys, fetchedAt: nowMs, expiresAt: nowMs + Math.min(Math.max(maxAge, 60), 24 * 3600) * 1000 };
  return keys;
}

async function googleKey(kid: string, nowMs = Date.now()): Promise<KeyObject | null> {
  if (jwksCache && jwksCache.expiresAt > nowMs) {
    const k = jwksCache.keys.get(kid);
    if (k) return k;
    // Unknown kid: Google may have rotated keys. Refetch, but at most once a minute.
    if (nowMs - jwksCache.fetchedAt < 60_000) return null;
  }
  return (await fetchJwks(nowMs)).get(kid) ?? null;
}

export interface GoogleIdentity {
  sub: string;
  /** Lower-cased. */
  email: string;
  name: string;
}

function b64json(part: string): Record<string, unknown> {
  const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  return v as Record<string, unknown>;
}

/**
 * Verify a Google ID token: RS256 signature (JWKS), iss, aud (= client id; azp when aud is a list), exp/iat,
 * nonce, email + email_verified. Throws GoogleAuthError('token' | 'unverified').
 */
export async function verifyIdToken(idToken: string, clientId: string, nonce: string, now = Math.floor(Date.now() / 1000)): Promise<GoogleIdentity> {
  const fail = (why: string): never => {
    console.warn(`[access] google id_token rejected: ${why}`);
    throw new GoogleAuthError('token');
  };
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[\w-]+$/.test(p))) fail('malformed');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64json(parts[0]);
    claims = b64json(parts[1]);
  } catch {
    return fail('malformed json');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') fail('alg/kid');
  let key: KeyObject | null;
  try {
    key = await googleKey(header.kid as string);
  } catch (err) {
    console.error('[access] google jwks fetch failed:', (err as Error)?.message);
    return fail('jwks unavailable');
  }
  if (!key) return fail('unknown kid');
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) fail('signature');

  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) fail('iss');
  const aud = claims.aud;
  if (Array.isArray(aud)) {
    if (!aud.includes(clientId) || claims.azp !== clientId) fail('aud');
  } else if (aud !== clientId) fail('aud');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= now) fail('expired');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > now) fail('iat in future');
  if (typeof claims.nonce !== 'string' || !sameString(claims.nonce, nonce)) fail('nonce');
  if (typeof claims.sub !== 'string' || !claims.sub) fail('sub');

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!email || !verified) {
    console.warn('[access] google sign-in with missing/unverified email');
    throw new GoogleAuthError('unverified');
  }
  return { sub: claims.sub as string, email, name: displayName(claims, email) };
}

/** Name from the Google profile (2–80 chars, no control characters), else the email's local part. */
function displayName(claims: Record<string, unknown>, email: string): string {
  const clean = (v: unknown) =>
    typeof v === 'string'
      ? // eslint-disable-next-line no-control-regex
        [...v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 80).join('').trim()
      : '';
  const given = [clean(claims.given_name), clean(claims.family_name)].filter(Boolean).join(' ');
  for (const c of [clean(claims.name), clean(given)]) if ([...c].length >= 2) return c;
  const local = clean(email.split('@')[0]);
  return [...local].length >= 2 ? local : email.slice(0, 80);
}

// ---------------------------------------------------------------- redirects

/** Error codes in /login?google=error&reason=<code>. */
export type GoogleErrorReason =
  | 'disabled' // GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured
  | 'rate_limited'
  | 'cancelled' // the user closed / declined Google's consent screen
  | 'google' // Google returned another error to the callback
  | 'state' // missing/forged/expired state, or the pv_gstate cookie does not match (other browser, >10 min)
  | 'exchange' // code → token exchange failed
  | 'token' // ID token failed verification (signature, iss, aud, exp, nonce)
  | 'unverified' // Google account without a verified email
  | 'store' // Redis error
  | 'mail' // could not email the owner the access request
  | 'config'; // server env incomplete (see /api/health)

/** 302 (relative Location) that never leaks the callback URL (it carries the code) via Referer. */
export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

export function clearStateCookie(req: Request): string {
  return serializeCookie(GSTATE_COOKIE, '', { maxAge: 0, path: GSTATE_COOKIE_PATH, secure: cookieSecure(req) });
}

export function googleErrorRedirect(req: Request, reason: GoogleErrorReason, cookies: string[] = []): Response {
  return redirect(`/login?google=error&reason=${reason}`, [clearStateCookie(req), ...cookies]);
}
