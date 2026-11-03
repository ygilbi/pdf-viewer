// "Sign in with Google": start → callback with a mocked Google (token endpoint + JWKS). The ID tokens are real
// RS256 JWTs signed with an RSA key generated here; the JWKS served to the code holds its public half.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { GET as googleStart, googleStartLimiter } from '../_routes/auth/google/start.js';
import { GET as googleCallback, googleCallbackLimiter } from '../_routes/auth/google/callback.js';
import { GET as providers } from '../_routes/auth/providers.js';
import { GET as inviteStatus } from '../_routes/auth/invite-status.js';
import { GET as me } from '../_routes/auth/me.js';
import { POST as requestAccess } from '../_routes/auth/request.js';
import { POST as approvePost } from '../_routes/approve.js';
import { POST as registerEmail } from '../_routes/auth/register/email.js';
import { GET as router } from '../router.js';
import { setMailerForTests } from '../_lib/mailer.js';
import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_URL, resetGoogleJwksCache, safeNext, signState } from '../_lib/google.js';
import { createMemoryStore, setStoreForTests, type Store, type UserRecord } from '../_lib/store.js';
import { signToken } from '../_lib/token.js';
import { CookieJar, ORIGIN, SECRET, fakeMailer, get, jsonPost, linkTo, setEnv } from './helpers.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-secret';
const EMAIL = 'dana@example.test';
const OWNER = 'owner@example.test';
const KID = 'test-kid-1';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

let mailer: ReturnType<typeof fakeMailer>;
let store: Store;
/** Claims (overrides) for the next id_token the mocked token endpoint returns; `nonce` is filled from the request. */
let claims: Record<string, unknown>;
let signingKey: KeyObject;
let tokenStatus: number;
let tokenRequests: URLSearchParams[];
let jwksFetches: number;

const nowS = () => Math.floor(Date.now() / 1000);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function idToken(c: Record<string, unknown>, key = signingKey, kid = KID): string {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64(c);
  const sig = cryptoSign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** The nonce Google would echo: taken from the authorization request the start endpoint built. */
let lastNonce = '';

function mockGoogle() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === GOOGLE_JWKS_URL) {
        jwksFetches++;
        const jwk = publicKey.export({ format: 'jwk' });
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=20000' },
        });
      }
      if (url === GOOGLE_TOKEN_URL) {
        const form = new URLSearchParams(String(init?.body ?? ''));
        tokenRequests.push(form);
        if (tokenStatus !== 200) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: tokenStatus });
        const c = {
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          azp: CLIENT_ID,
          sub: '1234567890',
          email: EMAIL,
          email_verified: true,
          name: 'Dana Cohen',
          iat: nowS(),
          exp: nowS() + 3600,
          nonce: lastNonce,
          ...claims,
        };
        return new Response(JSON.stringify({ access_token: 'at', id_token: idToken(c), token_type: 'Bearer', expires_in: 3599 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
  setEnv({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
  mailer = fakeMailer();
  setMailerForTests(mailer);
  store = createMemoryStore(() => Date.now());
  setStoreForTests(store);
  claims = {};
  signingKey = privateKey;
  tokenStatus = 200;
  tokenRequests = [];
  jwksFetches = 0;
  lastNonce = '';
  resetGoogleJwksCache();
  googleStartLimiter.reset();
  googleCallbackLimiter.reset();
  mockGoogle();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setMailerForTests(null);
  setStoreForTests(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Run /start, then the callback as Google would call it. Returns the callback response + the browser's jar. */
async function signIn(next?: string, tamper?: (q: URLSearchParams, jar: CookieJar) => void): Promise<{ res: Response; jar: CookieJar }> {
  const jar = new CookieJar();
  const start = await googleStart(get(`/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`));
  expect(start.status).toBe(302);
  jar.absorb(start);
  const auth = new URL(start.headers.get('location')!);
  lastNonce = auth.searchParams.get('nonce')!;
  const q = new URLSearchParams({ code: 'auth-code-1', state: auth.searchParams.get('state')!, scope: 'openid email profile' });
  tamper?.(q, jar);
  const res = await googleCallback(get(`/api/auth/google/callback?${q}`, jar));
  jar.absorb(res);
  return { res, jar };
}

const user = (status: UserRecord['status'], extra: Partial<UserRecord> = {}): UserRecord => ({
  id: 'uid',
  email: EMAIL,
  name: 'דנה',
  status,
  createdAt: 1,
  approvedAt: status === 'active' || status === 'approved' ? 1 : null,
  ...extra,
});

const loc = (res: Response) => res.headers.get('location');

describe('GET /api/auth/providers', () => {
  it('reports google: true + the public client id when configured (never the secret)', async () => {
    const body = await (await providers()).json();
    expect(body).toEqual({ ok: true, google: true, passkey: true, emailCode: true, googleClientId: CLIENT_ID });
    expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET);
  });
  it('exposes the Drive Picker config only with GOOGLE_API_KEY + a numeric GOOGLE_PROJECT_NUMBER', async () => {
    const base = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET };
    setEnv({ ...base, GOOGLE_API_KEY: 'AIza-test', GOOGLE_PROJECT_NUMBER: '123456789012' });
    expect(await (await providers()).json()).toEqual({
      ok: true,
      google: true,
      passkey: true,
      emailCode: true,
      googleClientId: CLIENT_ID,
      googlePickerApiKey: 'AIza-test',
      googleAppId: '123456789012',
    });
    setEnv({ ...base, GOOGLE_API_KEY: 'AIza-test' });
    expect(await (await providers()).json()).not.toHaveProperty('googlePickerApiKey');
    setEnv({ ...base, GOOGLE_API_KEY: 'AIza-test', GOOGLE_PROJECT_NUMBER: 'my-project' });
    expect(await (await providers()).json()).not.toHaveProperty('googleAppId');
    // No Google client → no Drive config at all.
    setEnv({ GOOGLE_API_KEY: 'AIza-test', GOOGLE_PROJECT_NUMBER: '123456789012' });
    const body = await (await providers()).json();
    expect(body).toEqual({ ok: true, google: false, passkey: true, emailCode: true });
  });
  it('safeNext keeps a Google Drive launch path with its state query', () => {
    const state = JSON.stringify({ ids: ['1AbCdEfGhIjKlMnOpQrStUvWxYz012345', '1ZyXwVuTsRqPoNmLkJiHgFeDcBa543210'], action: 'open', userId: '112233445566778899000', resourceKeys: { '1AbCdEfGhIjKlMnOpQrStUvWxYz012345': '0-AbCdEfGhIjKlMnOp' } });
    const next = `/drive/open?state=${encodeURIComponent(state)}`;
    expect(safeNext(next)).toBe(next);
    const viaLogin = `/login?after=google&next=${encodeURIComponent(next)}`;
    expect(safeNext(viaLogin)).toBe(viaLogin);
  });
  it('reports google: false without GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET', async () => {
    setEnv({ GOOGLE_CLIENT_ID: CLIENT_ID });
    expect(await (await providers()).json()).toEqual({ ok: true, google: false, passkey: true, emailCode: true });
    setEnv();
    const res = await router(new Request('https://x/api/router?__route=auth/providers'));
    expect(await res.json()).toEqual({ ok: true, google: false, passkey: true, emailCode: true });
  });
});

describe('GET /api/auth/google/start', () => {
  it('redirects to Google with a signed state, nonce and the pv_gstate cookie', async () => {
    const res = await googleStart(get('/api/auth/google/start?next=%2Fapi%2Fdownload'));
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('location')!);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    const nonce = u.searchParams.get('nonce')!;
    expect(nonce).toMatch(/^[\w-]{20,}$/);
    const state = JSON.parse(Buffer.from(u.searchParams.get('state')!.split('.')[0], 'base64url').toString());
    expect(state).toMatchObject({ t: 'gstate', nonce, next: '/api/download' });
    expect(state.exp - state.iat).toBe(600);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('pv_gstate='))!;
    expect(cookie).toContain(`pv_gstate=${nonce}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Path=/api/auth/google');
    expect(cookie).toContain('Secure');
    expect(u.toString()).not.toContain(CLIENT_SECRET);
  });

  it('drops unsafe next values', async () => {
    for (const bad of ['https://evil.test/', '//evil.test', '/\\evil.test', 'javascript:alert(1)']) {
      const u = new URL((await googleStart(get(`/api/auth/google/start?next=${encodeURIComponent(bad)}`))).headers.get('location')!);
      const state = JSON.parse(Buffer.from(u.searchParams.get('state')!.split('.')[0], 'base64url').toString());
      expect(state.next, bad).toBe('/');
    }
    expect(safeNext('/a/b?c=1#d')).toBe('/a/b?c=1#d');
    expect(safeNext('/%2F%2Fevil')).toBe('/%2F%2Fevil');
  });

  it('is disabled without Google env', async () => {
    setEnv();
    const res = await googleStart(get('/api/auth/google/start'));
    expect(res.status).toBe(302);
    expect(loc(res)).toBe('/login?google=error&reason=google_disabled');
  });
});

describe('GET /api/auth/google/callback', () => {
  it('signs in an active user and redirects to next', async () => {
    await store.putUser(user('active'));
    const { res, jar } = await signIn('/api/download');
    expect(res.status).toBe(302);
    expect(loc(res)).toBe('/api/download');
    expect(jar.cookies.has('pv_session')).toBe(true);
    expect(jar.cookies.has('pv_gstate')).toBe(false); // cleared
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await (await me(get('/api/auth/me', jar))).json()).toEqual({ ok: true, user: { name: 'דנה', email: EMAIL }, hasPasskey: false });
    // token exchange used the configured client + exact redirect URI
    expect(Object.fromEntries(tokenRequests[0])).toEqual({
      code: 'auth-code-1',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: `${ORIGIN}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    });
    expect((await store.getUser(EMAIL))?.googleSub).toBe('1234567890');
    expect(mailer.sent).toHaveLength(0);
  });

  it('defaults next to / and lower-cases the Google email', async () => {
    await store.putUser(user('active'));
    claims = { email: 'Dana@Example.TEST' };
    const { res, jar } = await signIn();
    expect(loc(res)).toBe('/');
    expect(jar.cookies.has('pv_session')).toBe(true);
  });

  it('caches the JWKS between sign-ins', async () => {
    await store.putUser(user('active'));
    await signIn();
    await signIn();
    expect(jwksFetches).toBe(1);
  });

  it('approved → active, invite voided, owner notified, session, /welcome', async () => {
    // Real request → approve flow so an invite exists.
    await requestAccess(jsonPost('/api/auth/request', { name: 'דנה כהן', email: EMAIL }));
    const approveUrl = linkTo(mailer.sent.find((m) => m.to === OWNER)!.html, '/api/approve?t=');
    await approvePost(new Request(approveUrl, { method: 'POST' }));
    const invite = new URL(linkTo(mailer.sent.at(-1)!.html, '/login?invite=')).searchParams.get('invite')!;
    mailer.sent.length = 0;

    const { res, jar } = await signIn('/api/download');
    expect(loc(res)).toBe('/welcome');
    expect(jar.cookies.has('pv_session')).toBe(true);
    const u = (await store.getUser(EMAIL))!;
    expect(u.status).toBe('active');
    expect(u.activatedAt).toBe(nowS());
    expect(u.googleSub).toBe('1234567890');
    expect(u.name).toBe('דנה כהן'); // the name from the request is kept

    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0];
    expect(m.to).toBe(OWNER);
    expect(m.subject).toBe('דנה כהן נרשם/ה בהצלחה ל-PDF Viewer (Google)');
    expect(m.html).toContain('נרשם/ה בהצלחה (Google)');
    expect(linkTo(m.html, '/api/revoke?t=')).toContain(`${ORIGIN}/api/revoke?t=`);

    // The emailed invite can no longer be used.
    const reg = await registerEmail(jsonPost('/api/auth/register/email', { invite }));
    expect(reg.status).toBe(410);
    expect(((await reg.json()) as J).code).toBe('invite_used');
    // …and invite-status explains it.
    const st = (await (await inviteStatus(get(`/api/auth/invite-status?invite=${encodeURIComponent(invite)}`))).json()) as J;
    expect(st).toEqual({ ok: true, email: EMAIL, name: 'דנה כהן', status: 'active', expired: false, used: true });
  });

  it('unknown user → access request to the owner (verified by Google) → pending redirect, no session', async () => {
    const { res, jar } = await signIn();
    expect(loc(res)).toBe(`/login?google=pending&email=${encodeURIComponent(EMAIL)}`);
    expect(jar.cookies.has('pv_session')).toBe(false);
    const u = (await store.getUser(EMAIL))!;
    expect(u).toMatchObject({ status: 'pending', name: 'Dana Cohen', email: EMAIL, requestedAt: nowS(), googleSub: '1234567890' });
    const owner = mailer.sent.filter((m) => m.to === OWNER);
    expect(owner).toHaveLength(1);
    expect(owner[0].subject).toBe('בקשת גישה ל-PDF Viewer: Dana Cohen (Google)');
    expect(owner[0].html).toContain('כתובת המייל אומתה על ידי Google');
    expect(owner[0].replyTo).toBe(EMAIL);
    // The approve link works like a form request.
    mailer.sent.length = 0;
    expect((await approvePost(new Request(linkTo(owner[0].html, '/api/approve?t='), { method: 'POST' }))).status).toBe(200);
    expect((await store.getUser(EMAIL))!.status).toBe('approved');
    expect(mailer.sent[0].to).toBe(EMAIL);
  });

  it('does not email the owner again for a pending request younger than 24 h', async () => {
    await signIn();
    expect(mailer.sent.filter((m) => m.to === OWNER)).toHaveLength(1);
    vi.setSystemTime(Date.now() + 3600 * 1000);
    const { res } = await signIn();
    expect(loc(res)).toBe(`/login?google=pending&email=${encodeURIComponent(EMAIL)}`);
    expect(mailer.sent.filter((m) => m.to === OWNER)).toHaveLength(1);
    vi.setSystemTime(Date.now() + 24 * 3600 * 1000);
    await signIn();
    expect(mailer.sent.filter((m) => m.to === OWNER)).toHaveLength(2);
  });

  it('revoked user → new access request (session epoch kept)', async () => {
    await store.putUser(user('revoked', { sessionEpoch: 3 }));
    const { res, jar } = await signIn();
    expect(loc(res)).toContain('/login?google=pending');
    expect(jar.cookies.has('pv_session')).toBe(false);
    expect(await store.getUser(EMAIL)).toMatchObject({ status: 'pending', sessionEpoch: 3, id: 'uid' });
    expect(mailer.sent.some((m) => m.to === OWNER)).toBe(true);
  });

  it('denied user → /login?google=denied, nothing sent', async () => {
    await store.putUser(user('denied'));
    const { res, jar } = await signIn();
    expect(loc(res)).toBe('/login?google=denied');
    expect(jar.cookies.has('pv_session')).toBe(false);
    expect(mailer.sent).toHaveLength(0);
    expect((await store.getUser(EMAIL))!.status).toBe('denied');
  });

  it('mail failure → reason=mail; a retry then emails the owner', async () => {
    setMailerForTests({ send: async () => Promise.reject(new Error('smtp down')) });
    const { res } = await signIn();
    expect(loc(res)).toBe('/login?google=error&reason=mail_failed');
    setMailerForTests(mailer);
    await signIn();
    expect(mailer.sent.filter((m) => m.to === OWNER)).toHaveLength(1);
  });

  describe('rejects', () => {
    beforeEach(async () => {
      await store.putUser(user('active'));
    });
    const expectError = async (p: Promise<{ res: Response; jar: CookieJar }>, reason: string) => {
      const { res, jar } = await p;
      expect(res.status).toBe(302);
      expect(loc(res)).toBe(`/login?google=error&reason=${reason}`);
      expect(jar.cookies.has('pv_session')).toBe(false);
      expect(jar.cookies.has('pv_gstate')).toBe(false);
    };

    it('a missing pv_gstate cookie (other browser)', () => expectError(signIn(undefined, (_q, jar) => jar.cookies.clear()), 'state_invalid'));
    it('a cookie nonce that does not match the state', () => expectError(signIn(undefined, (_q, jar) => jar.cookies.set('pv_gstate', 'x'.repeat(32))), 'state_invalid'));
    it('a forged state', () =>
      expectError(
        signIn(undefined, (q, jar) => {
          const forged = signState(jar.cookies.get('pv_gstate')!, '/', 'another-secret-0123456789abcdef0123', nowS());
          q.set('state', forged);
        }),
        'state_invalid',
      ));
    it('an expired state (> 10 min)', async () => {
      const p = signIn(undefined, () => vi.setSystemTime(Date.now() + 11 * 60 * 1000));
      await expectError(p, 'state_expired');
    });
    it('a missing code', () => expectError(signIn(undefined, (q) => q.delete('code')), 'state_invalid'));
    it('the user cancelling at Google', async () => {
      const res = await googleCallback(get('/api/auth/google/callback?error=access_denied&state=x'));
      expect(loc(res)).toBe('/login?google=error&reason=access_denied');
    });
    it('a failed token exchange', () => {
      tokenStatus = 400;
      return expectError(signIn(), 'exchange_failed');
    });
    it('a wrong audience', () => {
      claims = { aud: 'someone-else.apps.googleusercontent.com' };
      return expectError(signIn(), 'token_invalid');
    });
    it('an audience list without our azp', () => {
      claims = { aud: [CLIENT_ID, 'other'], azp: 'other' };
      return expectError(signIn(), 'token_invalid');
    });
    it('a wrong issuer', () => {
      claims = { iss: 'https://evil.example' };
      return expectError(signIn(), 'token_invalid');
    });
    it('accepts the bare accounts.google.com issuer', async () => {
      claims = { iss: 'accounts.google.com' };
      expect(loc((await signIn()).res)).toBe('/');
    });
    it('an expired id_token', () => {
      claims = { iat: nowS() - 7200, exp: nowS() - 3600 };
      return expectError(signIn(), 'token_invalid');
    });
    it('a nonce mismatch in the id_token', () => {
      claims = { nonce: 'not-the-nonce' };
      return expectError(signIn(), 'token_invalid');
    });
    it('a signature by another key', () => {
      signingKey = other.privateKey;
      return expectError(signIn(), 'token_invalid');
    });
    it('email_verified false', () => {
      claims = { email_verified: false };
      return expectError(signIn(), 'email_unverified');
    });
    it('a missing email', () => {
      claims = { email: undefined };
      return expectError(signIn(), 'no_email');
    });
    it('everything when Google is disabled', async () => {
      setEnv();
      const res = await googleCallback(get('/api/auth/google/callback?code=x&state=y'));
      expect(loc(res)).toBe('/login?google=error&reason=google_disabled');
    });
  });
});

describe('GET /api/auth/invite-status', () => {
  const invite = (exp: number, jti = 'jti-1', secret = SECRET) =>
    signToken({ t: 'invite', name: 'דנה כהן', email: EMAIL, jti, iat: nowS(), exp }, secret);
  const status = async (token: string) => {
    const res = await inviteStatus(get(`/api/auth/invite-status?invite=${encodeURIComponent(token)}`));
    return { status: res.status, body: (await res.json()) as J };
  };

  it('returns the invite email/name and the user status', async () => {
    await store.putUser(user('approved'));
    await store.putInvite('jti-1', EMAIL, 3600);
    expect(await status(invite(nowS() + 3600))).toEqual({
      status: 200,
      body: { ok: true, email: EMAIL, name: 'דנה כהן', status: 'approved', expired: false, used: false },
    });
  });

  it('works for used and expired invites of active users', async () => {
    await store.putUser(user('active'));
    expect((await status(invite(nowS() - 10))).body).toEqual({ ok: true, email: EMAIL, name: 'דנה כהן', status: 'active', expired: true, used: true });
  });

  it('reports unknown when there is no user record', async () => {
    expect((await status(invite(nowS() + 10))).body.status).toBe('unknown');
  });

  it('rejects bad signatures and other token types', async () => {
    expect((await status(invite(nowS() + 10, 'j', 'wrong-secret-0123456789abcdef0123456789'))).body.code).toBe('invite_invalid');
    const revoke = signToken({ t: 'revoke', name: 'x', email: EMAIL, iat: nowS(), exp: nowS() + 10 }, SECRET);
    expect(await status(revoke)).toMatchObject({ status: 410, body: { ok: false, code: 'invite_invalid' } });
    const res = await inviteStatus(get('/api/auth/invite-status'));
    expect(res.status).toBe(410);
  });
});
