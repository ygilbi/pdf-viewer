// Compact HMAC-SHA256 signed tokens: base64url(JSON payload) + "." + base64url(signature).
// Validity = valid signature + matching type + not expired. Invite tokens are additionally single-use
// (their jti must still exist in Redis). Rotating SIGNING_SECRET invalidates every token and session.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ApprovePayload {
  t: 'approve';
  name: string;
  email: string;
  company?: string;
  message?: string;
  iat: number;
  exp: number;
}

/** One-time passkey registration link sent to an approved requester. Single use is enforced via invite:{jti} in Redis. */
export interface InvitePayload {
  t: 'invite';
  name: string;
  email: string;
  jti: string;
  iat: number;
  exp: number;
}

/** Owner-only link (in the "registered" notification) that revokes a user's access. */
export interface RevokePayload {
  t: 'revoke';
  name: string;
  email: string;
  iat: number;
  exp: number;
}

export type TokenPayload = ApprovePayload | InvitePayload | RevokePayload;
export type TokenType = TokenPayload['t'];

export type VerifyResult<P> = { ok: true; payload: P } | { ok: false; reason: 'malformed' | 'signature' | 'type' | 'expired' };

const DAY_SECONDS = 24 * 60 * 60;
export const APPROVE_TTL_DAYS = 14;
export const REVOKE_TTL_DAYS = 365;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
export const daysFromNow = (days: number, now = nowSeconds()): number => now + Math.round(days * DAY_SECONDS);

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function signToken(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret).toString('base64url')}`;
}

export function verifyToken<T extends TokenType>(
  token: string | null | undefined,
  secret: string,
  type: T,
  now = nowSeconds(),
): VerifyResult<Extract<TokenPayload, { t: T }>> {
  if (!token || token.length > 8192) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]) || !/^[\w-]+$/.test(parts[1])) {
    return { ok: false, reason: 'malformed' };
  }
  const [body, sig] = parts;
  const expected = sign(body, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  const p = payload as Partial<TokenPayload>;
  if (p.t !== type) return { ok: false, reason: 'type' };
  if (typeof p.exp !== 'number' || typeof p.email !== 'string' || typeof p.name !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (p.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p as Extract<TokenPayload, { t: T }> };
}
