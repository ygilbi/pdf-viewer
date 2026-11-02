import { describe, expect, it } from 'vitest';
import { MSG, formatCountdown, fromApi, fromEmailVerify, fromWebAuthn, isInviteError } from './messages';

describe('fromWebAuthn', () => {
  it('maps a cancelled login to the Hebrew message + QR / request hint', () => {
    const r = fromWebAuthn({ name: 'NotAllowedError', message: 'x' }, 'login');
    expect(r.message).toContain(MSG.loginCancelled);
    expect(r.message).toContain('QR');
    expect(r.hints).toContain('request');
  });
  it('maps a cancelled registration', () => {
    expect(fromWebAuthn({ name: 'NotAllowedError' }, 'register').message).toBe(MSG.registerCancelled);
  });
  it('maps an already-registered authenticator', () => {
    expect(fromWebAuthn({ name: 'InvalidStateError', code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' }, 'register').message).toBe(
      MSG.alreadyRegistered,
    );
  });
  it('maps RP ID / domain problems with the health hint', () => {
    expect(fromWebAuthn({ name: 'SecurityError', code: 'ERROR_INVALID_RP_ID' }, 'login').hints).toEqual(['health']);
  });
});

describe('fromApi', () => {
  it('adds the health hint for server_config / mail_failed', () => {
    expect(fromApi({ code: 'server_config', error: 'x' }, 'request').hints).toEqual(['health']);
    expect(fromApi({ code: 'mail_failed', error: 'x' }, 'request').hints).toEqual(['health']);
    expect(fromApi({ code: 'bad_input', error: 'x' }, 'request').hints).toEqual([]);
  });
  it('offers a new request for invite problems', () => {
    expect(fromApi({ code: 'invite_expired', error: 'x' }, 'register').hints).toEqual(['request']);
    expect(fromApi({ code: 'whatever', error: 'x', status: 410 }, 'register').hints).toEqual(['request']);
    expect(isInviteError('rate_limited', 429)).toBe(false);
  });
});

describe('fromEmailVerify', () => {
  it('counts attempts left', () => {
    expect(fromEmailVerify({ code: 'code_invalid', error: 'x', attemptsLeft: 3 })).toMatchObject({ message: 'הקוד שגוי. נותרו 3 ניסיונות.', resend: false });
    expect(fromEmailVerify({ code: 'code_invalid', error: 'x', attemptsLeft: 1 }).message).toContain('נותר ניסיון אחד');
    expect(fromEmailVerify({ code: 'code_invalid', error: 'x' })).toMatchObject({ message: 'הקוד שגוי.', resend: false });
    expect(fromEmailVerify({ code: 'code_invalid', error: 'x', attemptsLeft: 0 }).resend).toBe(true);
  });
  it('expired / too many → resend', () => {
    expect(fromEmailVerify({ code: 'code_expired', error: 'x', status: 410 })).toMatchObject({ resend: true, code: 'code_expired' });
    expect(fromEmailVerify({ code: 'too_many_attempts', error: 'x', status: 429 })).toMatchObject({ resend: true });
  });
  it('anything else keeps the server message', () => {
    expect(fromEmailVerify({ code: 'server_config', error: 'חסר', status: 500 })).toMatchObject({ message: 'חסר', hints: ['health'], resend: false });
  });
});

describe('fromApi (email start)', () => {
  it('offers a request for unregistered addresses', () => {
    expect(fromApi({ code: 'not_registered', error: 'x', status: 404 }, 'login').hints).toEqual(['request']);
  });
});

describe('formatCountdown', () => {
  it('formats m:ss', () => {
    expect(formatCountdown(30)).toBe('0:30');
    expect(formatCountdown(5.2)).toBe('0:06');
    expect(formatCountdown(75)).toBe('1:15');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});
