import { describe, expect, it } from 'vitest';
import { MSG, fromApi, fromWebAuthn, isInviteError } from './messages';

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
