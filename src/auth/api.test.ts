import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiRequest,
  emailStart,
  emailVerify,
  getMe,
  loginOptions,
  loginUrl,
  passkeyAddOptions,
  passkeyAddVerify,
  registerEmail,
  requestAccess,
  safeNext,
} from './api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('apiRequest', () => {
  it('POSTs JSON with same-origin credentials and returns the ok body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, alreadyActive: true }));
    const r = await requestAccess({ name: 'דנה', email: 'd@x.co', website: '' }, { fetchImpl });
    expect(r).toEqual({ ok: true, alreadyActive: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/request');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'דנה', email: 'd@x.co', website: '' });
  });

  it('passes the server error code and Hebrew message through', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { ok: false, code: 'server_config', error: 'חסרה הגדרה' }));
    const r = await loginOptions({ fetchImpl });
    expect(r).toEqual({ ok: false, code: 'server_config', error: 'חסרה הגדרה', status: 500 });
  });

  it('maps non-JSON answers to bad_response with a status-based message', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 502 }));
    const r = await apiRequest('GET', 'x', undefined, { fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('bad_response');
      expect(r.status).toBe(502);
      expect(r.error).toMatch(/שרת/);
    }
  });

  it('maps fetch rejections to code network', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const r = await apiRequest('GET', 'x', undefined, { fetchImpl });
    expect(r).toMatchObject({ ok: false, code: 'network', status: 0 });
  });

  it('aborts after the timeout with code timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
    );
    const p = apiRequest('GET', 'x', undefined, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toMatchObject({ ok: false, code: 'timeout' });
  });
});

function lastCall(fetchImpl: { mock: { calls: unknown[][] } }) {
  const [url, init] = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [string, RequestInit];
  return { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body as string) };
}

describe('e-mail code endpoints', () => {
  it('emailStart POSTs the address', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, sent: true }));
    expect(await emailStart('a@b.co', { fetchImpl })).toEqual({ ok: true, sent: true });
    expect(lastCall(fetchImpl)).toEqual({ url: '/api/auth/email/start', method: 'POST', body: { email: 'a@b.co' } });
  });
  it('emailStart surfaces too_soon with retryAfter', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { ok: false, code: 'too_soon', error: 'המתן', retryAfter: 17.2 }));
    expect(await emailStart('a@b.co', { fetchImpl })).toEqual({ ok: false, code: 'too_soon', error: 'המתן', status: 429, retryAfter: 18 });
  });
  it('falls back to the Retry-After header', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, code: 'rate_limited', error: 'x' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        }),
    );
    expect(await emailStart('a@b.co', { fetchImpl })).toMatchObject({ code: 'rate_limited', retryAfter: 60 });
  });
  it('emailStart passes not_registered through', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { ok: false, code: 'not_registered', error: 'לא רשום' }));
    const r = await emailStart('a@b.co', { fetchImpl });
    expect(r).toEqual({ ok: false, code: 'not_registered', error: 'לא רשום', status: 404 });
    expect('retryAfter' in r).toBe(false);
  });
  it('emailVerify POSTs email + code and returns the user', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, user: { name: 'דנה', email: 'a@b.co' } }));
    expect(await emailVerify('a@b.co', '123456', { fetchImpl })).toEqual({ ok: true, user: { name: 'דנה', email: 'a@b.co' } });
    expect(lastCall(fetchImpl)).toEqual({ url: '/api/auth/email/verify', method: 'POST', body: { email: 'a@b.co', code: '123456' } });
  });
  it('emailVerify surfaces attemptsLeft / expired / too many', async () => {
    let fetchImpl = vi.fn(async () => jsonResponse(400, { ok: false, code: 'code_invalid', error: 'שגוי', attemptsLeft: 2 }));
    expect(await emailVerify('a@b.co', '000000', { fetchImpl })).toMatchObject({ ok: false, code: 'code_invalid', attemptsLeft: 2, status: 400 });
    fetchImpl = vi.fn(async () => jsonResponse(410, { ok: false, code: 'code_expired', error: 'פג' }));
    expect(await emailVerify('a@b.co', '000000', { fetchImpl })).toMatchObject({ ok: false, code: 'code_expired', status: 410 });
    fetchImpl = vi.fn(async () => jsonResponse(429, { ok: false, code: 'too_many_attempts', error: 'רבים' }));
    expect(await emailVerify('a@b.co', '000000', { fetchImpl })).toMatchObject({ ok: false, code: 'too_many_attempts', status: 429 });
  });
  it('registerEmail POSTs the invite', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, user: { name: 'A', email: 'a@b.co' } }));
    expect(await registerEmail('tok', { fetchImpl })).toMatchObject({ ok: true, user: { name: 'A' } });
    expect(lastCall(fetchImpl)).toEqual({ url: '/api/auth/register/email', method: 'POST', body: { invite: 'tok' } });
    const gone = vi.fn(async () => jsonResponse(410, { ok: false, code: 'invite_expired', error: 'פג' }));
    expect(await registerEmail('tok', { fetchImpl: gone })).toMatchObject({ ok: false, code: 'invite_expired', status: 410 });
  });
});

describe('passkey add endpoints', () => {
  it('options + verify', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, options: { challenge: 'c' } }));
    expect(await passkeyAddOptions({ fetchImpl })).toMatchObject({ ok: true, options: { challenge: 'c' } });
    expect(lastCall(fetchImpl)).toEqual({ url: '/api/auth/passkey/add/options', method: 'POST', body: {} });
    const verify = vi.fn(async () => jsonResponse(200, { ok: true }));
    const response = { id: 'x' } as unknown as Parameters<typeof passkeyAddVerify>[0];
    expect(await passkeyAddVerify(response, { fetchImpl: verify })).toEqual({ ok: true });
    expect(lastCall(verify)).toEqual({ url: '/api/auth/passkey/add/verify', method: 'POST', body: { response: { id: 'x' } } });
  });
  it('401 when signed out', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { ok: false, code: 'unauthorized', error: 'נדרשת כניסה' }));
    expect(await passkeyAddOptions({ fetchImpl })).toMatchObject({ ok: false, code: 'unauthorized', status: 401 });
  });
});

describe('getMe', () => {
  it('reads hasPasskey next to or inside user', async () => {
    const top = vi.fn(async () => jsonResponse(200, { ok: true, user: { name: 'A', email: 'a@b.co' }, hasPasskey: false }));
    expect(await getMe({ fetchImpl: top })).toEqual({ state: 'signed-in', user: { name: 'A', email: 'a@b.co', hasPasskey: false } });
    const inner = vi.fn(async () => jsonResponse(200, { ok: true, user: { name: 'A', email: 'a@b.co', hasPasskey: true } }));
    expect(await getMe({ fetchImpl: inner })).toEqual({ state: 'signed-in', user: { name: 'A', email: 'a@b.co', hasPasskey: true } });
  });
  it('signed-in on ok', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, user: { name: 'A', email: 'a@b.co' } }));
    expect(await getMe({ fetchImpl })).toEqual({ state: 'signed-in', user: { name: 'A', email: 'a@b.co' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/me');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });
  it('signed-out on 401 (JSON or not)', async () => {
    expect(await getMe({ fetchImpl: async () => jsonResponse(401, { ok: false, code: 'unauthorized', error: 'x' }) })).toEqual({
      state: 'signed-out',
    });
    expect(await getMe({ fetchImpl: async () => new Response('', { status: 401 }) })).toEqual({ state: 'signed-out' });
  });
  it('unknown on offline / 5xx / 404 (app stays usable)', async () => {
    expect(await getMe({ fetchImpl: async () => Promise.reject(new TypeError('offline')) })).toEqual({ state: 'unknown' });
    expect(await getMe({ fetchImpl: async () => new Response('', { status: 503 }) })).toEqual({ state: 'unknown' });
    expect(await getMe({ fetchImpl: async () => new Response('nope', { status: 404 }) })).toEqual({ state: 'unknown' });
  });
});

describe('safeNext', () => {
  it('keeps same-origin relative paths', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/api/download')).toBe('/api/download');
    expect(safeNext('/x/y?a=1&b=%D7%90#h')).toBe('/x/y?a=1&b=%D7%90#h');
  });
  it('falls back for missing / empty values', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext(null, '/app')).toBe('/app');
  });
  it.each([
    'https://evil.com',
    'http://evil.com/x',
    '//evil.com',
    '//evil.com/%2F..',
    '/\\evil.com',
    '\\\\evil.com',
    '/\\/evil.com',
    'javascript:alert(1)',
    'data:text/html,x',
    'evil.com',
    ' /x',
    '/\t/evil.com',
    '/\n/evil.com',
    '/x\\y',
    '/' + 'a'.repeat(3000),
  ])('rejects %j', (bad) => {
    expect(safeNext(bad)).toBe('/');
  });
  it('never loops back to the login page', () => {
    expect(safeNext('/login')).toBe('/');
    expect(safeNext('/login.html?next=/x')).toBe('/');
    expect(safeNext('/login/')).toBe('/');
    expect(safeNext('/logins')).toBe('/logins');
  });
  it('normalizes dot segments without leaving the origin', () => {
    expect(safeNext('/a/../../b')).toBe('/b');
    expect(safeNext('/./x')).toBe('/x');
  });
});

describe('loginUrl', () => {
  it('encodes next', () => {
    expect(loginUrl('/a?b=1&c=2')).toBe('/login?next=%2Fa%3Fb%3D1%26c%3D2');
  });
});
