import { describe, expect, it } from 'vitest';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import {
  DEVICE_KEYS_KEY,
  MAX_DEVICE_KEYS,
  QUICK_LOGIN_DISMISS_MS,
  clearQuickLoginDismissal,
  deviceLoginOptions,
  dismissQuickLogin,
  excludedIds,
  isQuickLoginDismissed,
  keepKnownDeviceKeys,
  loadDeviceKeys,
  platformRegistrationOptions,
  removeDeviceKey,
  saveDeviceKey,
} from './deviceKeys';
import { PREFETCH_MAX_AGE_MS, PREFETCH_REFRESH_MS, isFresh } from './prefetch';

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('device passkey memory', () => {
  it('saves newest first, dedupes and keeps name / email / createdAt', () => {
    const s = memStore();
    saveDeviceKey({ id: 'a', email: 'a@x.co', name: 'A', createdAt: 1 }, s);
    saveDeviceKey({ id: 'b', email: 'b@x.co', name: 'B', createdAt: 2 }, s);
    const list = saveDeviceKey({ id: 'a', createdAt: 99 }, s);
    expect(list.map((k) => k.id)).toEqual(['a', 'b']);
    expect(list[0]).toEqual({ id: 'a', email: 'a@x.co', name: 'A', createdAt: 1 });
    expect(JSON.parse(s.raw.get(DEVICE_KEYS_KEY)!)).toHaveLength(2);
  });

  it(`keeps at most ${MAX_DEVICE_KEYS}`, () => {
    const s = memStore();
    for (let i = 0; i < 15; i++) saveDeviceKey({ id: `k${i}`, createdAt: i }, s);
    const list = loadDeviceKeys(s);
    expect(list).toHaveLength(MAX_DEVICE_KEYS);
    expect(list[0].id).toBe('k14');
  });

  it('removes one id and clears the key when empty', () => {
    const s = memStore();
    saveDeviceKey({ id: 'a' }, s);
    saveDeviceKey({ id: 'b' }, s);
    expect(removeDeviceKey('a', s).map((k) => k.id)).toEqual(['b']);
    expect(removeDeviceKey('b', s)).toEqual([]);
    expect(s.raw.has(DEVICE_KEYS_KEY)).toBe(false);
  });

  it('keeps only ids the server still knows', () => {
    const s = memStore();
    for (const id of ['a', 'b', 'c']) saveDeviceKey({ id }, s);
    expect(keepKnownDeviceKeys(['a', 'c', 'zzz'], s).map((k) => k.id)).toEqual(['c', 'a']);
    expect(loadDeviceKeys(s).map((k) => k.id)).toEqual(['c', 'a']);
  });

  it('survives garbage and blocked storage', () => {
    expect(loadDeviceKeys(memStore({ [DEVICE_KEYS_KEY]: '{nope' }))).toEqual([]);
    expect(loadDeviceKeys(memStore({ [DEVICE_KEYS_KEY]: '{"a":1}' }))).toEqual([]);
    expect(loadDeviceKeys(memStore({ [DEVICE_KEYS_KEY]: '[null, {"id":""}, {"id":"x","email":5}]' }))).toEqual([
      { id: 'x', email: '', name: '', createdAt: 0 },
    ]);
    expect(loadDeviceKeys(throwing)).toEqual([]);
    expect(() => saveDeviceKey({ id: 'a' }, throwing)).not.toThrow();
    expect(loadDeviceKeys(null)).toEqual([]);
  });
});

describe('quick sign-in dismissal', () => {
  it('lasts 30 days', () => {
    const s = memStore();
    expect(isQuickLoginDismissed(1000, s)).toBe(false);
    dismissQuickLogin(1000, s);
    expect(isQuickLoginDismissed(1000 + QUICK_LOGIN_DISMISS_MS - 1, s)).toBe(true);
    expect(isQuickLoginDismissed(1000 + QUICK_LOGIN_DISMISS_MS, s)).toBe(false);
    clearQuickLoginDismissal(s);
    expect(isQuickLoginDismissed(1001, s)).toBe(false);
    expect(isQuickLoginDismissed(1, throwing)).toBe(false);
  });
});

describe('deviceLoginOptions', () => {
  const base: PublicKeyCredentialRequestOptionsJSON = { challenge: 'c', rpId: 'x.app', timeout: 1, userVerification: 'required' };

  it('restricts to the remembered ids with transport internal + client-device hint (no QR chooser)', () => {
    expect(deviceLoginOptions(base, ['a', 'b'])).toEqual({
      ...base,
      allowCredentials: [
        { id: 'a', type: 'public-key', transports: ['internal'] },
        { id: 'b', type: 'public-key', transports: ['internal'] },
      ],
      hints: ['client-device'],
    });
  });

  it("prefers the server's list but forces transport internal", () => {
    const o = deviceLoginOptions({ ...base, allowCredentials: [{ id: 's', type: 'public-key', transports: ['hybrid', 'internal'] }] }, ['a']);
    expect(o.allowCredentials).toEqual([{ id: 's', type: 'public-key', transports: ['internal'] }]);
    expect(o.hints).toEqual(['client-device']);
  });

  it('defaults userVerification to required', () => {
    expect(deviceLoginOptions({ challenge: 'c' }, ['a']).userVerification).toBe('required');
  });
});

describe('platformRegistrationOptions / excludedIds', () => {
  const base = {
    challenge: 'c',
    rp: { name: 'r' },
    user: { id: 'u', name: 'n', displayName: 'd' },
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    excludeCredentials: [{ id: 'old1', type: 'public-key' }, { id: 'old2', type: 'public-key' }],
    authenticatorSelection: { residentKey: 'preferred', authenticatorAttachment: 'cross-platform' },
  } as PublicKeyCredentialCreationOptionsJSON;

  it('forces a platform authenticator and the client-device hint', () => {
    const o = platformRegistrationOptions(base);
    expect(o.authenticatorSelection).toEqual({ residentKey: 'preferred', userVerification: 'required', authenticatorAttachment: 'platform' });
    expect(o.hints).toEqual(['client-device']);
    expect(o.challenge).toBe('c');
  });

  it('lists the excluded ids', () => {
    expect(excludedIds(base)).toEqual(['old1', 'old2']);
    expect(excludedIds({ ...base, excludeCredentials: undefined })).toEqual([]);
  });
});

describe('prefetch freshness', () => {
  it('refreshes before the 5-minute challenge expires', () => {
    expect(PREFETCH_REFRESH_MS).toBe(4 * 60_000);
    expect(PREFETCH_MAX_AGE_MS).toBeLessThan(5 * 60_000);
    expect(isFresh(0, PREFETCH_MAX_AGE_MS - 1)).toBe(true);
    expect(isFresh(0, PREFETCH_MAX_AGE_MS)).toBe(false);
    expect(isFresh(null, 0)).toBe(false);
    expect(isFresh(10, 5)).toBe(false); // clock went backwards
  });
});
