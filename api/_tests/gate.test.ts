import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideGate, restUserLoader, shouldGate, type GateRequest } from '../_lib/gate.js';
import { readCookie, signSession, verifySession } from '../_lib/session.js';
import middleware, { config as middlewareConfig } from '../../middleware.js';
import { SECRET, setEnv } from './helpers.js';

const nav = (path: string, cookie: string | null = null): GateRequest => ({
  url: `https://app.example.test${path}`,
  cookie,
  secFetchMode: 'navigate',
  secFetchDest: 'document',
});
const active = async () => ({ status: 'active' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session token', () => {
  it('round-trips and rejects tampering, wrong secret and expiry', async () => {
    const now = 1_800_000_000;
    const tok = await signSession('dana@example.test', 30, SECRET, 2, now);
    expect(await verifySession(tok, SECRET, now + 10)).toEqual({ t: 'session', sub: 'dana@example.test', iat: now, exp: now + 30 * 86400, ep: 2 });
    expect(await verifySession(tok, SECRET + 'x', now)).toBeNull();
    expect(await verifySession(tok, SECRET, now + 30 * 86400)).toBeNull();
    const [, sig] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ t: 'session', sub: 'evil@example.test', iat: now, exp: now + 99, ep: 2 })).toString('base64url');
    expect(await verifySession(`${forged}.${sig}`, SECRET, now)).toBeNull();
    for (const bad of [null, '', 'a.b.c', 'x', '!!.??']) expect(await verifySession(bad, SECRET, now)).toBeNull();
  });

  it('readCookie finds a cookie among several', () => {
    expect(readCookie('a=1; pv_session=abc.def; b=2', 'pv_session')).toBe('abc.def');
    expect(readCookie('a=1', 'pv_session')).toBeNull();
    expect(readCookie(null, 'pv_session')).toBeNull();
  });
});

describe('shouldGate', () => {
  it.each([
    ['/', true],
    ['/index.html', true],
    ['/some/spa/route', true],
    ['/welcome', true],
    ['/welcome.html', true],
    ['/login', false],
    ['/login.html', false],
    ['/download', false],
    ['/download.html', false],
    ['/api/auth/me', false],
    ['/api/download', false],
    ['/assets/index-abc.js', false],
    ['/icons/favicon.ico', false],
    ['/manifest.webmanifest', false],
    ['/sw.js', false],
    ['/demo-facade.pdf', false],
  ])('%s → %s', (path, expected) => {
    expect(shouldGate(path)).toBe(expected);
  });
});

describe('decideGate', () => {
  it('redirects a navigation without a session to /login?next=', async () => {
    expect(await decideGate(nav('/'), { secret: SECRET, loadUser: active })).toEqual({ action: 'redirect', location: '/login?next=%2F', reason: 'no_session' });
    expect(await decideGate(nav('/index.html?file=x'), { secret: SECRET, loadUser: active })).toMatchObject({
      location: '/login?next=%2Findex.html%3Ffile%3Dx',
    });
  });

  it('gates the Google Drive Open URL and keeps its state query in next', async () => {
    const state = encodeURIComponent(JSON.stringify({ ids: ['1AbC_d-9'], action: 'open', userId: '1234' }));
    const d = await decideGate(nav(`/drive/open?state=${state}`), { secret: SECRET, loadUser: active });
    expect(d).toMatchObject({ action: 'redirect', reason: 'no_session' });
    const next = new URL((d as { location: string }).location, 'https://h.test').searchParams.get('next');
    expect(next).toBe(`/drive/open?state=${state}`);
  });

  it('lets an active session through', async () => {
    const cookie = `pv_session=${await signSession('dana@example.test', 30, SECRET)}`;
    const loadUser = vi.fn(active);
    expect(await decideGate(nav('/', cookie), { secret: SECRET, loadUser })).toEqual({ action: 'next' });
    expect(loadUser).toHaveBeenCalledWith('dana@example.test');
  });

  it('redirects revoked/missing users, stale epochs, forged cookies and store errors', async () => {
    const cookie = `pv_session=${await signSession('dana@example.test', 30, SECRET)}`;
    for (const loadUser of [async () => ({ status: 'revoked' }), async () => null, async () => ({ status: 'active', sessionEpoch: 1 })]) {
      expect(await decideGate(nav('/', cookie), { secret: SECRET, loadUser })).toMatchObject({ action: 'redirect', reason: 'inactive' });
    }
    expect(await decideGate(nav('/', cookie), { secret: 'other-secret-0123456789abcdef01234567', loadUser: active })).toMatchObject({ reason: 'no_session' });
    expect(
      await decideGate(nav('/', cookie), {
        secret: SECRET,
        loadUser: async () => {
          throw new Error('down');
        },
      }),
    ).toMatchObject({ reason: 'store_error' });
  });

  it('never touches public paths and passes non-navigation fetches of the shell (service worker precache)', async () => {
    const loadUser = vi.fn(active);
    for (const p of ['/login', '/download', '/api/auth/me', '/assets/a.js', '/sw.js']) {
      expect(await decideGate(nav(p), { secret: SECRET, loadUser })).toEqual({ action: 'next' });
    }
    expect(
      await decideGate({ url: 'https://app.example.test/index.html', cookie: null, secFetchMode: 'cors', secFetchDest: 'empty' }, { secret: SECRET, loadUser }),
    ).toEqual({ action: 'next' });
    // Clients that send no Sec-Fetch headers (curl, old browsers) are treated as navigations.
    expect(
      await decideGate({ url: 'https://app.example.test/', cookie: null, secFetchMode: null, secFetchDest: null }, { secret: SECRET, loadUser }),
    ).toMatchObject({ action: 'redirect' });
    expect(loadUser).not.toHaveBeenCalled();
  });
});

describe('restUserLoader', () => {
  it('reads user:{email} via the Upstash REST API', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: JSON.stringify({ status: 'active' }) })));
    const load = restUserLoader('https://kv.example.test/', 'tok', fetchMock as unknown as typeof fetch);
    expect(await load('dana@example.test')).toEqual({ status: 'active' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://kv.example.test/get/user%3Adana%40example.test');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');

    const missing = restUserLoader('https://kv.example.test', 'tok', (async () => new Response('{"result":null}')) as unknown as typeof fetch);
    expect(await missing('x@example.test')).toBeNull();
    const failing = restUserLoader('https://kv.example.test', 'tok', (async () => new Response('', { status: 401 })) as unknown as typeof fetch);
    await expect(failing('x@example.test')).rejects.toThrow('401');
  });
});

describe('middleware.ts', () => {
  it('keeps the privacy / terms pages public (Marketplace listing; cleanUrls serves them extension-less)', () => {
    for (const p of ['/privacy', '/privacy.html', '/terms', '/terms.html']) expect(shouldGate(p)).toBe(false);
    expect(shouldGate('/drive/open')).toBe(true);
  });
  it('declares a matcher for the app HTML only', () => {
    expect(middlewareConfig.matcher).toContain('/');
    expect(middlewareConfig.matcher).toContain('/index.html');
    expect(middlewareConfig.matcher).toContain('/welcome.html');
  });

  it('matcher covers /welcome and /welcome.html but not /login.html, /download.html or files', () => {
    // Vercel matchers are path-to-regexp patterns; the catch-all here is a plain regex group.
    const catchAll = new RegExp(`^${middlewareConfig.matcher[middlewareConfig.matcher.length - 1]}$`);
    const matches = (p: string) => middlewareConfig.matcher.includes(p) || catchAll.test(p);
    for (const p of ['/', '/index.html', '/welcome', '/welcome.html', '/some/route']) expect(matches(p), p).toBe(true);
    for (const p of ['/login', '/login.html', '/download', '/download.html', '/api/auth/me', '/assets/a.js', '/sw.js']) expect(matches(p), p).toBe(false);
  });

  it('redirects /welcome and /welcome.html without a session', async () => {
    setEnv();
    const headers = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    for (const p of ['/welcome', '/welcome.html']) {
      const res = await middleware(new Request(`https://app.example.test${p}`, { headers }));
      expect(res!.status).toBe(302);
      expect(res!.headers.get('location')).toBe(`https://app.example.test/login?next=${encodeURIComponent(p)}`);
    }
  });

  it('302s to /login without a session and continues with one', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: JSON.stringify({ status: 'active' }) }))));
    const headers = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    const res = await middleware(new Request('https://app.example.test/', { headers }));
    expect(res!.status).toBe(302);
    expect(res!.headers.get('location')).toBe('https://app.example.test/login?next=%2F');

    const cookie = `pv_session=${await signSession('dana@example.test', 30, SECRET)}`;
    expect(await middleware(new Request('https://app.example.test/', { headers: { ...headers, cookie } }))).toBeUndefined();
  });

  it('fails closed when Redis is not configured', async () => {
    setEnv({ KV_REST_API_URL: undefined });
    const cookie = `pv_session=${await signSession('dana@example.test', 30, SECRET)}`;
    const res = await middleware(new Request('https://app.example.test/', { headers: { cookie } }));
    expect(res!.status).toBe(302);
  });
});
