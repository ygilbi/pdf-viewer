// End-to-end access flow with real WebAuthn crypto (software authenticator), in-memory store and fake mailer:
// request → owner approves → invite → passkey registration → session → logout → passkey login → revoke.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as requestAccess } from '../_routes/auth/request.js';
import { POST as approvePost } from '../_routes/approve.js';
import { POST as denyPost } from '../_routes/deny.js';
import { GET as revokeGet, POST as revokePost } from '../_routes/revoke.js';
import { POST as regOptions } from '../_routes/auth/register/options.js';
import { POST as regVerify } from '../_routes/auth/register/verify.js';
import { POST as loginOptions } from '../_routes/auth/login/options.js';
import { POST as loginVerify } from '../_routes/auth/login/verify.js';
import { GET as me } from '../_routes/auth/me.js';
import { POST as logout } from '../_routes/auth/logout.js';
import { setMailerForTests } from '../_lib/mailer.js';
import { createMemoryStore, setStoreForTests, type Store } from '../_lib/store.js';
import { nowSeconds, signToken, verifyToken } from '../_lib/token.js';
import { CookieJar, ORIGIN, SECRET, fakeMailer, get, jsonPost, linkTo, setEnv } from './helpers.js';
import { SoftAuthenticator } from './softAuthenticator.js';

let mailer: ReturnType<typeof fakeMailer>;
let store: Store;

beforeEach(() => {
  setEnv();
  mailer = fakeMailer();
  setMailerForTests(mailer);
  store = createMemoryStore();
  setStoreForTests(store);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setMailerForTests(null);
  setStoreForTests(null);
  vi.restoreAllMocks();
});

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<J> => (await res.json()) as J;

const EMAIL = 'dana@example.test';

/** Request access + owner approval; returns the invite token from the requester's email. */
async function approvedInvite(email = EMAIL): Promise<string> {
  expect((await requestAccess(jsonPost('/api/auth/request', { name: 'דנה כהן', email }))).status).toBe(200);
  const approveUrl = linkTo(mailer.sent.find((m) => m.to === 'owner@example.test')!.html, '/api/approve?t=');
  mailer.sent.length = 0;
  expect((await approvePost(new Request(approveUrl, { method: 'POST' }))).status).toBe(200);
  const invite = new URL(linkTo(mailer.sent[0].html, '/login?invite=')).searchParams.get('invite')!;
  mailer.sent.length = 0;
  return invite;
}

async function register(invite: string, auth: SoftAuthenticator, jar = new CookieJar()) {
  const o = await regOptions(jsonPost('/api/auth/register/options', { invite }));
  const oj = await json(o);
  if (!oj.ok) return { res: o, body: oj, jar };
  const res = await regVerify(jsonPost('/api/auth/register/verify', { invite, response: auth.create(oj.options) }));
  jar.absorb(res);
  return { res, body: await json(res), jar, options: oj };
}

async function login(auth: SoftAuthenticator, jar = new CookieJar(), opts?: { bumpCounter?: boolean }) {
  const o = await loginOptions(jsonPost('/api/auth/login/options', {}));
  expect(o.status).toBe(200);
  jar.absorb(o);
  const oj = await json(o);
  const res = await loginVerify(jsonPost('/api/auth/login/verify', { response: auth.get(oj.options, opts) }, jar));
  jar.absorb(res);
  return { res, body: await json(res), jar, options: oj };
}

describe('passkey registration', () => {
  it('returns creation options that require a discoverable, user-verified credential', async () => {
    const invite = await approvedInvite();
    const res = await regOptions(jsonPost('/api/auth/register/options', { invite }));
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.ok).toBe(true);
    expect(b.user).toEqual({ name: 'דנה כהן', email: EMAIL });
    expect(b.options.rp).toEqual({ name: 'PDF Viewer', id: 'app.example.test' });
    expect(b.options.user.name).toBe(EMAIL);
    expect(b.options.attestation).toBe('none');
    expect(b.options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(b.options.authenticatorSelection.authenticatorAttachment).toBeUndefined();
    expect(b.options.hints).toEqual(['client-device', 'hybrid']);
    expect(typeof b.options.challenge).toBe('string');
  });

  it('full flow: register → session → /me → owner notified with a revoke link', async () => {
    const invite = await approvedInvite();
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const { res, body, jar } = await register(invite, auth);
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, user: { name: 'דנה כהן', email: EMAIL } });

    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('pv_session='))!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=2592000/);

    const user = (await store.getUser(EMAIL))!;
    expect(user.status).toBe('active');
    expect(await store.listCredIds(EMAIL)).toEqual([auth.id]);
    expect(await store.getCred(auth.id)).toMatchObject({ userEmail: EMAIL, counter: 0, transports: ['internal', 'hybrid'] });

    const meRes = await me(get('/api/auth/me', jar));
    expect(meRes.status).toBe(200);
    expect(await json(meRes)).toEqual({ ok: true, user: { name: 'דנה כהן', email: EMAIL }, hasPasskey: true });

    const notice = mailer.sent.find((m) => m.to === 'owner@example.test')!;
    expect(notice.subject).toContain('נרשם/ה בהצלחה');
    expect(notice.html).toContain('בטל גישה');
    const revokeUrl = linkTo(notice.html, '/api/revoke?t=');
    expect(verifyToken(new URL(revokeUrl).searchParams.get('t'), SECRET, 'revoke').ok).toBe(true);
  });

  it('the invite is single-use', async () => {
    const invite = await approvedInvite();
    expect((await register(invite, new SoftAuthenticator({ origin: ORIGIN }))).res.status).toBe(200);
    const again = await register(invite, new SoftAuthenticator({ origin: ORIGIN }));
    expect(again.res.status).toBe(410);
    expect(again.body).toMatchObject({ ok: false, code: 'invite_used', error: expect.stringMatching(/[֐-׿]/) });
    expect(await store.listCredIds(EMAIL)).toHaveLength(1);
  });

  it('two verifications racing on one invite: only one wins', async () => {
    const invite = await approvedInvite();
    const o = await json(await regOptions(jsonPost('/api/auth/register/options', { invite })));
    const a = new SoftAuthenticator({ origin: ORIGIN });
    const r1 = await regVerify(jsonPost('/api/auth/register/verify', { invite, response: a.create(o.options) }));
    // Same challenge again: already consumed.
    const r2 = await regVerify(jsonPost('/api/auth/register/verify', { invite, response: new SoftAuthenticator({ origin: ORIGIN }).create(o.options) }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects expired, tampered, unknown and not-approved invites', async () => {
    const now = nowSeconds();
    const expired = signToken({ t: 'invite', name: 'x', email: EMAIL, jti: 'j1', iat: now - 10, exp: now - 1 }, SECRET);
    expect(await json(await regOptions(jsonPost('/api/auth/register/options', { invite: expired })))).toMatchObject({ code: 'invite_expired' });
    expect(await json(await regOptions(jsonPost('/api/auth/register/options', { invite: 'abc.def' })))).toMatchObject({ code: 'invite_invalid' });
    expect(await json(await regOptions(jsonPost('/api/auth/register/options', {})))).toMatchObject({ code: 'invite_invalid' });
    const unknown = signToken({ t: 'invite', name: 'x', email: EMAIL, jti: 'nope', iat: now, exp: now + 100 }, SECRET);
    expect(await json(await regOptions(jsonPost('/api/auth/register/options', { invite: unknown })))).toMatchObject({ code: 'invite_used' });

    // Owner approved, then later denied (e.g. clicked deny on a second request): invite no longer usable.
    const invite = await approvedInvite();
    await requestAccess(jsonPost('/api/auth/request', { name: 'דנה כהן', email: EMAIL }));
    const denyUrl = linkTo(mailer.sent.find((m) => m.to === 'owner@example.test')!.html, '/api/deny?t=');
    await denyPost(new Request(denyUrl, { method: 'POST' }));
    const r = await regOptions(jsonPost('/api/auth/register/options', { invite }));
    expect(r.status).toBe(403);
    expect(await json(r)).toMatchObject({ code: 'not_approved' });
  });

  it('rejects a wrong origin, a missing user verification flag and a missing challenge', async () => {
    const invite = await approvedInvite();
    const evil = await register(invite, new SoftAuthenticator({ origin: 'https://evil.example' }));
    expect(evil.body).toMatchObject({ ok: false, code: 'verification_failed' });

    const noUv = await register(invite, new SoftAuthenticator({ origin: ORIGIN, userVerified: false }));
    expect(noUv.body).toMatchObject({ ok: false, code: 'verification_failed' });

    // verify without a prior options call → no stored challenge
    const res = await regVerify(jsonPost('/api/auth/register/verify', { invite, response: new SoftAuthenticator({ origin: ORIGIN }).create({ challenge: 'x', rp: { id: 'app.example.test' }, user: { id: 'u' } }) }));
    expect(await json(res)).toMatchObject({ code: 'challenge_expired' });

    // The invite survived all failed attempts and still works.
    expect((await register(invite, new SoftAuthenticator({ origin: ORIGIN }))).res.status).toBe(200);
  });

  it('RP_ID overrides the hostname of APP_URL', async () => {
    setEnv({ RP_ID: 'example.test' });
    const invite = await approvedInvite();
    const b = await json(await regOptions(jsonPost('/api/auth/register/options', { invite })));
    expect(b.options.rp.id).toBe('example.test');
  });
});

describe('passkey login', () => {
  async function registered(): Promise<SoftAuthenticator> {
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    expect((await register(await approvedInvite(), auth)).res.status).toBe(200);
    mailer.sent.length = 0;
    return auth;
  }

  it('login/options returns discoverable-credential options and sets the pv_chal cookie', async () => {
    const res = await loginOptions(jsonPost('/api/auth/login/options', {}));
    const b = await json(res);
    expect(b.ok).toBe(true);
    expect(b.options.rpId).toBe('app.example.test');
    expect(b.options.userVerification).toBe('required');
    expect(b.options.allowCredentials ?? []).toEqual([]);
    const chal = res.headers.getSetCookie().find((c) => c.startsWith('pv_chal='))!;
    expect(chal).toMatch(/HttpOnly/);
    expect(chal).toMatch(/Max-Age=300/);
    expect(chal).toMatch(/Path=\/api\/auth/);
  });

  it('logout clears the session; passkey login creates a new one and updates the counter', async () => {
    const auth = await registered();
    const out = await logout(jsonPost('/api/auth/logout', {}));
    expect(out.headers.getSetCookie()[0]).toMatch(/^pv_session=; .*Max-Age=0/);
    expect((await me(get('/api/auth/me'))).status).toBe(401);
    expect(await json(await me(get('/api/auth/me')))).toMatchObject({ ok: false, code: 'unauthenticated' });

    const { res, body, jar } = await login(auth);
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, user: { name: 'דנה כהן', email: EMAIL } });
    expect(jar.cookies.has('pv_session')).toBe(true);
    expect(jar.cookies.has('pv_chal')).toBe(false); // cleared
    expect((await store.getCred(auth.id))!.counter).toBe(1);
    expect((await me(get('/api/auth/me', jar))).status).toBe(200);
  });

  it('rejects a replayed counter, a reused challenge and a missing challenge cookie', async () => {
    const auth = await registered();
    expect((await login(auth)).res.status).toBe(200);
    const replay = await login(auth, new CookieJar(), { bumpCounter: false });
    expect(replay.body).toMatchObject({ ok: false, code: 'verification_failed' });

    // Reusing a challenge id after it was consumed.
    const o = await loginOptions(jsonPost('/api/auth/login/options', {}));
    const jar = new CookieJar().absorb(o);
    const opts = (await json(o)).options;
    expect((await loginVerify(jsonPost('/api/auth/login/verify', { response: auth.get(opts) }, jar))).status).toBe(200);
    const again = await loginVerify(jsonPost('/api/auth/login/verify', { response: auth.get(opts) }, jar));
    expect(await json(again)).toMatchObject({ code: 'challenge_expired' });

    const noCookie = await loginVerify(jsonPost('/api/auth/login/verify', { response: auth.get(opts) }));
    expect(await json(noCookie)).toMatchObject({ code: 'challenge_expired' });
  });

  it('rejects an unknown passkey and a wrong origin', async () => {
    const auth = await registered();
    expect((await login(new SoftAuthenticator({ origin: ORIGIN }))).body).toMatchObject({ code: 'unknown_credential' });
    auth.origin = 'https://evil.example';
    expect((await login(auth)).body).toMatchObject({ code: 'verification_failed' });
  });
});

describe('revoke', () => {
  it('owner revokes: passkeys deleted, existing session dead, login impossible, re-request emails owner again', async () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const { jar } = await register(await approvedInvite(), auth);
    const revokeUrl = linkTo(mailer.sent.find((m) => m.to === 'owner@example.test')!.html, '/api/revoke?t=');
    mailer.sent.length = 0;

    const confirm = await revokeGet(new Request(revokeUrl));
    expect(await confirm.text()).toMatch(/<form method="post" action="\/api\/revoke\?t=/);
    expect((await store.getUser(EMAIL))!.status).toBe('active'); // GET changes nothing

    const done = await revokePost(new Request(revokeUrl, { method: 'POST' }));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('הגישה בוטלה');
    expect((await store.getUser(EMAIL))!.status).toBe('revoked');
    expect(await store.listCredIds(EMAIL)).toEqual([]);
    expect(await store.getCred(auth.id)).toBeNull();

    expect((await me(get('/api/auth/me', jar))).status).toBe(401);
    expect((await login(auth)).body).toMatchObject({ code: 'unknown_credential' });

    // A revoked user whose passkey still exists (e.g. revoked by status only) cannot log in either.
    await store.putCred(auth.id, { userEmail: EMAIL, publicKey: 'AA', counter: 0, transports: [], createdAt: 0 });
    expect((await login(auth)).body).toMatchObject({ code: 'not_active' });

    // Re-approval: old sessions stay invalid even though the user is active again.
    const invite2 = await approvedInvite();
    const auth2 = new SoftAuthenticator({ origin: ORIGIN });
    const { jar: jar2 } = await register(invite2, auth2);
    expect((await me(get('/api/auth/me', jar2))).status).toBe(200);
    expect((await me(get('/api/auth/me', jar))).status).toBe(401);
  });
});
