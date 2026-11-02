import { describe, expect, it } from 'vitest';
import { signToken, verifyToken, type RevokePayload } from '../_lib/token.js';
import { SECRET } from './helpers.js';

const now = 1_800_000_000;
const payload: RevokePayload = { t: 'revoke', name: 'דנה', email: 'dana@example.test', iat: now, exp: now + 3600 };

describe('token', () => {
  it('round-trips a valid token', () => {
    const tok = signToken(payload, SECRET);
    expect(tok).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(verifyToken(tok, SECRET, 'revoke', now)).toEqual({ ok: true, payload });
  });

  it('rejects expired tokens', () => {
    const tok = signToken(payload, SECRET);
    expect(verifyToken(tok, SECRET, 'revoke', now + 3600)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a tampered payload', () => {
    const tok = signToken(payload, SECRET);
    const [, sig] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, email: 'evil@example.test' })).toString('base64url');
    expect(verifyToken(`${forged}.${sig}`, SECRET, 'revoke', now)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects a tampered signature and a wrong secret', () => {
    const tok = signToken(payload, SECRET);
    const flipped = tok.slice(0, -2) + (tok.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyToken(flipped, SECRET, 'revoke', now).ok).toBe(false);
    expect(verifyToken(tok, SECRET + 'x', 'revoke', now)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects the wrong token type', () => {
    const tok = signToken(payload, SECRET);
    expect(verifyToken(tok, SECRET, 'approve', now)).toEqual({ ok: false, reason: 'type' });
    expect(verifyToken(tok, SECRET, 'invite', now)).toEqual({ ok: false, reason: 'type' });
  });

  it('rejects malformed input', () => {
    for (const t of [null, '', 'abc', 'a.b.c', 'a b.c', `${'x'.repeat(9000)}.y`]) {
      expect(verifyToken(t, SECRET, 'revoke', now)).toMatchObject({ ok: false });
    }
  });
});
