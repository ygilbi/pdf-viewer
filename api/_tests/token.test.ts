import { describe, expect, it } from 'vitest';
import { signToken, verifyToken, type DownloadPayload } from '../_lib/token.js';
import { SECRET } from './helpers.js';

const now = 1_800_000_000;
const payload: DownloadPayload = { t: 'download', name: 'דנה', email: 'dana@example.test', iat: now, exp: now + 3600 };

describe('token', () => {
  it('round-trips a valid token', () => {
    const tok = signToken(payload, SECRET);
    expect(tok).toMatch(/^[\w-]+\.[\w-]+$/);
    const v = verifyToken(tok, SECRET, 'download', now);
    expect(v).toEqual({ ok: true, payload });
  });

  it('rejects expired tokens', () => {
    const tok = signToken(payload, SECRET);
    expect(verifyToken(tok, SECRET, 'download', now + 3600)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a tampered payload', () => {
    const tok = signToken(payload, SECRET);
    const [, sig] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, email: 'evil@example.test' })).toString('base64url');
    expect(verifyToken(`${forged}.${sig}`, SECRET, 'download', now)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects a tampered signature and a wrong secret', () => {
    const tok = signToken(payload, SECRET);
    const flipped = tok.slice(0, -2) + (tok.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyToken(flipped, SECRET, 'download', now).ok).toBe(false);
    expect(verifyToken(tok, SECRET + 'x', 'download', now)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects the wrong token type', () => {
    const tok = signToken(payload, SECRET);
    expect(verifyToken(tok, SECRET, 'approve', now)).toEqual({ ok: false, reason: 'type' });
  });

  it('rejects malformed input', () => {
    for (const t of [null, '', 'abc', 'a.b.c', 'a b.c', `${'x'.repeat(9000)}.y`]) {
      expect(verifyToken(t, SECRET, 'download', now)).toMatchObject({ ok: false });
    }
  });
});
