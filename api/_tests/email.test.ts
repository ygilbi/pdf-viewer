// Email-code login (auth/email/start + verify), registration without a passkey (auth/register/email),
// adding a passkey later (auth/passkey/add/*) and /me.hasPasskey. In-memory store, fake mailer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as requestAccess } from '../_routes/auth/request.js';
import { POST as approvePost } from '../_routes/approve.js';
import { POST as revokePost } from '../_routes/revoke.js';
import { POST as emailStart, emailStartIpLimiter } from '../_routes/auth/email/start.js';
import { POST as emailVerify, emailVerifyIpLimiter } from '../_routes/auth/email/verify.js';
import { POST as registerEmail } from '../_routes/auth/register/email.js';
import { POST as regOptions } from '../_routes/auth/register/options.js';
import { POST as addOptions } from '../_routes/auth/passkey/add/options.js';
import { POST as addVerify } from '../_routes/auth/passkey/add/verify.js';
import { POST as loginOptions } from '../_routes/auth/login/options.js';
import { POST as loginVerify } from '../_routes/auth/login/verify.js';
import { GET as me } from '../_routes/auth/me.js';
import { setMailerForTests } from '../_lib/mailer.js';
import { createMemoryStore, setStoreForTests, type Store } from '../_lib/store.js';
import { hashOtp, parseOtpInput } from '../_lib/otp.js';
import { verifyToken } from '../_lib/token.js';
import { revokeUrl as makeRevokeUrl } from '../_lib/decision.js';
import { CookieJar, ORIGIN, SECRET, fakeMailer, get, jsonPost, linkTo, setEnv } from './helpers.js';
import { SoftAuthenticator } from './softAuthenticator.js';

let mailer: ReturnType<typeof fakeMailer>;
let store: Store;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
  setEnv();
  mailer = fakeMailer();
  setMailerForTests(mailer);
  store = createMemoryStore(() => Date.now());
  setStoreForTests(store);
  emailStartIpLimiter.reset();
  emailVerifyIpLimiter.reset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setMailerForTests(null);
  setStoreForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<J> => (await res.json()) as J;
const advance = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);

const EMAIL = 'dana@example.test';
const OWNER = 'owner@example.test';

async function approvedInvite(email = EMAIL): Promise<string> {
  expect((await requestAccess(jsonPost('/api/auth/request', { name: 'דנה כהן', email }))).status).toBe(200);
  const approveUrl = linkTo(mailer.sent.find((m) => m.to === OWNER)!.html, '/api/approve?t=');
  mailer.sent.length = 0;
  expect((await approvePost(new Request(approveUrl, { method: 'POST' }))).status).toBe(200);
  const invite = new URL(linkTo(mailer.sent[0].html, '/login?invite=')).searchParams.get('invite')!;
  mailer.sent.length = 0;
  return invite;
}

/** Registered (active) user without a passkey; returns the session jar from register/email. */
async function registeredByEmail(email = EMAIL): Promise<CookieJar> {
  const res = await registerEmail(jsonPost('/api/auth/register/email', { invite: await approvedInvite(email) }));
  expect(res.status).toBe(200);
  mailer.sent.length = 0;
  return new CookieJar().absorb(res);
}

function lastCode(to = EMAIL): string {
  const m = [...mailer.sent].reverse().find((x) => x.to === to);
  if (!m) throw new Error('no code mail');
  return m.text.match(/PDF Viewer: (\d{6})/)![1];
}

const start = (email = EMAIL) => emailStart(jsonPost('/api/auth/email/start', { email }));
const verify = (code: unknown, email = EMAIL) => emailVerify(jsonPost('/api/auth/email/verify', { email, code }));

describe('POST /api/auth/register/email (registration without a passkey)', () => {
  it('activates the user, sets a session, notifies the owner with a revoke link; the invite is single-use', async () => {
    const invite = await approvedInvite();
    const res = await registerEmail(jsonPost('/api/auth/register/email', { invite }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, user: { name: 'דנה כהן', email: EMAIL } });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('pv_session='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(await store.getUser(EMAIL)).toMatchObject({ status: 'active' });
    expect(await store.listCredIds(EMAIL)).toEqual([]);

    const notice = mailer.sent.find((m) => m.to === OWNER)!;
    expect(notice.subject).toContain('נרשם/ה בהצלחה');
    expect(notice.html).toContain('נרשם/ה עם קוד במייל');
    expect(notice.html).toContain('בטל גישה');
    expect(verifyToken(new URL(linkTo(notice.html, '/api/revoke?t=')).searchParams.get('t'), SECRET, 'revoke').ok).toBe(true);

    const jar = new CookieJar().absorb(res);
    expect(await json(await me(get('/api/auth/me', jar)))).toEqual({ ok: true, user: { name: 'דנה כהן', email: EMAIL }, hasPasskey: false });

    const again = await registerEmail(jsonPost('/api/auth/register/email', { invite }));
    expect(again.status).toBe(410);
    expect(await json(again)).toMatchObject({ ok: false, code: 'invite_used' });
    // ...and the same invite cannot be used for a passkey either.
    expect(await json(await regOptions(jsonPost('/api/auth/register/options', { invite })))).toMatchObject({ code: 'invite_used' });
  });

  it('rejects invalid / missing invites with the invite_* codes', async () => {
    expect(await json(await registerEmail(jsonPost('/api/auth/register/email', { invite: 'abc.def' })))).toMatchObject({ code: 'invite_invalid' });
    const r = await registerEmail(jsonPost('/api/auth/register/email', {}));
    expect(r.status).toBe(410);
    expect(await json(r)).toMatchObject({ code: 'invite_invalid' });
  });

  it('the invite email offers both passkey and email code', async () => {
    await requestAccess(jsonPost('/api/auth/request', { name: 'דנה כהן', email: EMAIL }));
    const approveUrl = linkTo(mailer.sent.find((m) => m.to === OWNER)!.html, '/api/approve?t=');
    mailer.sent.length = 0;
    await approvePost(new Request(approveUrl, { method: 'POST' }));
    const m = mailer.sent[0];
    expect(m.html).toContain('קוד במייל');
    expect(m.text).toContain('אפשר להירשם עם טביעת אצבע / זיהוי פנים / Windows Hello, או להמשיך עם קוד במייל');
    expect(linkTo(m.html, '/login?invite=')).toMatch(/^https:\/\/app\.example\.test\/login\?invite=/);
  });
});

describe('email code login', () => {
  it('happy path: code mailed (hash stored, not the code) → verify sets a session → code is single-use', async () => {
    await registeredByEmail();
    const res = await start();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, sent: true });

    const mail = mailer.sent.at(-1)!;
    expect(mail.to).toBe(EMAIL);
    expect(mail.subject).toMatch(/^קוד הכניסה שלך ל-PDF Viewer: \d{6}$/);
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.html).toContain('monospace');
    expect(mail.html).toContain('10 דקות');
    expect(mail.html).toContain('אם לא ביקשת — התעלם');
    const code = lastCode();

    const otp = (await store.getOtp(EMAIL))!;
    expect(otp).toEqual({ hash: hashOtp(EMAIL, code, SECRET), exp: Math.floor(Date.now() / 1000) + 600, attempts: 0 });
    expect(JSON.stringify([...(store.kv as unknown as { dump(): Map<string, unknown> }).dump()])).not.toContain(`"${code}"`);

    const ok = await verify(code, 'Dana@Example.test');
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ ok: true, user: { name: 'דנה כהן', email: EMAIL } });
    const jar = new CookieJar().absorb(ok);
    expect(jar.cookies.has('pv_session')).toBe(true);
    expect((await me(get('/api/auth/me', jar))).status).toBe(200);
    expect(await store.getOtp(EMAIL)).toBeNull();

    const reuse = await verify(code);
    expect(reuse.status).toBe(410);
    expect(await json(reuse)).toMatchObject({ code: 'code_expired' });
  });

  it('accepts a code typed with spaces', () => {
    expect(parseOtpInput(' 123 456 ')).toBe('123456');
    expect(parseOtpInput('12345')).toBeNull();
    expect(parseOtpInput('abcdef')).toBeNull();
  });

  it('wrong code → code_invalid with attemptsLeft; the 5th wrong attempt → too_many_attempts and the code is deleted', async () => {
    await registeredByEmail();
    await start();
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let left = 4; left >= 1; left--) {
      const r = await verify(wrong);
      expect(r.status).toBe(400);
      expect(await json(r)).toMatchObject({ ok: false, code: 'code_invalid', attemptsLeft: left, error: expect.stringMatching(/[֐-׿]/) });
    }
    const fifth = await verify(wrong);
    expect(fifth.status).toBe(429);
    expect(await json(fifth)).toMatchObject({ code: 'too_many_attempts' });
    expect(await store.getOtp(EMAIL)).toBeNull();
    // Even the right code no longer works.
    expect(await json(await verify(code))).toMatchObject({ code: 'code_expired' });
  });

  it('a new code resets the attempt counter', async () => {
    await registeredByEmail();
    await start();
    await verify('999999' === lastCode() ? '888888' : '999999');
    advance(31);
    await start();
    const r = await verify(lastCode() === '999999' ? '888888' : '999999');
    expect(await json(r)).toMatchObject({ code: 'code_invalid', attemptsLeft: 4 });
    expect((await verify(lastCode())).status).toBe(200);
  });

  it('expired code → code_expired 410', async () => {
    await registeredByEmail();
    await start();
    const code = lastCode();
    advance(9 * 60 + 59);
    expect(await store.getOtp(EMAIL)).not.toBeNull();
    // Record still present but past its exp (e.g. clock skew with the Redis TTL).
    await store.kv.set(`otp:${EMAIL}`, JSON.stringify({ ...(await store.getOtp(EMAIL))!, exp: Math.floor(Date.now() / 1000) - 1 }), 60);
    const r = await verify(code);
    expect(r.status).toBe(410);
    expect(await json(r)).toMatchObject({ code: 'code_expired' });

    advance(31);
    await start();
    const code2 = lastCode();
    advance(10 * 60 + 1); // Redis TTL elapsed
    expect(await json(await verify(code2))).toMatchObject({ code: 'code_expired' });
  });

  it('resend throttling: 30 s between sends (too_soon + retryAfter), max 5 per hour (rate_limited)', async () => {
    await registeredByEmail();
    expect((await start()).status).toBe(200);
    const soon = await start();
    expect(soon.status).toBe(429);
    const sb = await json(soon);
    expect(sb).toMatchObject({ ok: false, code: 'too_soon', retryAfter: 30 });
    expect(soon.headers.get('retry-after')).toBe('30');
    advance(10);
    expect(await json(await start())).toMatchObject({ code: 'too_soon', retryAfter: 20 });

    for (let i = 2; i <= 5; i++) {
      advance(31);
      expect((await start()).status).toBe(200);
    }
    expect(mailer.sent.filter((m) => m.to === EMAIL)).toHaveLength(5);
    advance(31);
    const limited = await start();
    expect(limited.status).toBe(429);
    const lb = await json(limited);
    expect(lb).toMatchObject({ code: 'rate_limited' });
    expect(lb.retryAfter).toBeGreaterThan(0);
    expect(lb.retryAfter).toBeLessThanOrEqual(3600);

    // The latest code still works.
    expect((await verify(lastCode())).status).toBe(200);
    // After an hour the window slides.
    advance(3600);
    expect((await start()).status).toBe(200);
  });

  it('not_registered (404) for unknown, pending and revoked users; no mail is sent', async () => {
    const r = await start('nobody@example.test');
    expect(r.status).toBe(404);
    expect(await json(r)).toEqual({ ok: false, code: 'not_registered', error: 'כתובת המייל לא רשומה או שעדיין לא אושרה. בקש/י גישה.' });

    await approvedInvite(); // approved but not registered yet
    expect(await json(await start())).toMatchObject({ code: 'not_registered' });

    await registeredByEmail('eli@example.test');
    const revokeUrl = makeRevokeUrl(ORIGIN, SECRET, 'eli', 'eli@example.test', 1);
    await revokePost(new Request(revokeUrl, { method: 'POST' }));
    expect(await json(await start('eli@example.test'))).toMatchObject({ code: 'not_registered' });
    expect(mailer.sent).toHaveLength(0);

    expect(await json(await start('not-an-email'))).toMatchObject({ code: 'bad_request' });
  });

  it('a code issued before revocation cannot be used afterwards', async () => {
    await registeredByEmail();
    await start();
    const code = lastCode();
    const u = (await store.getUser(EMAIL))!;
    await store.putUser({ ...u, status: 'revoked', sessionEpoch: 1 });
    const r = await verify(code);
    expect(r.status).toBe(403);
    expect(await json(r)).toMatchObject({ code: 'not_active' });
  });

  it('mail failure → mail_failed 502 and the send slot is released', async () => {
    await registeredByEmail();
    mailer.send = async () => {
      throw new Error('smtp down');
    };
    const r = await start();
    expect(r.status).toBe(502);
    expect(await json(r)).toMatchObject({ code: 'mail_failed' });
    expect(await store.getOtp(EMAIL)).toBeNull();
    expect(await store.getOtpSends(EMAIL)).toEqual([]);
  });
});

describe('adding a passkey later (auth/passkey/add/*)', () => {
  it('requires a session (401)', async () => {
    const o = await addOptions(jsonPost('/api/auth/passkey/add/options', {}));
    expect(o.status).toBe(401);
    expect(await json(o)).toMatchObject({ code: 'unauthenticated' });
    const v = await addVerify(jsonPost('/api/auth/passkey/add/verify', { response: {} }));
    expect(v.status).toBe(401);
  });

  it('email-registered user adds a passkey → hasPasskey true → can log in with it', async () => {
    const jar = await registeredByEmail();
    const o = await addOptions(jsonPost('/api/auth/passkey/add/options', {}, jar));
    expect(o.status).toBe(200);
    const ob = await json(o);
    expect(ob.options.authenticatorSelection).toMatchObject({ authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' });
    expect(ob.options.hints).toEqual(['client-device']);
    expect(ob.user).toEqual({ name: 'דנה כהן', email: EMAIL });

    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const v = await addVerify(jsonPost('/api/auth/passkey/add/verify', { response: auth.create(ob.options) }, jar));
    expect(v.status).toBe(200);
    expect(await json(v)).toEqual({ ok: true, user: { name: 'דנה כהן', email: EMAIL }, hasPasskey: true, credentialId: auth.id });
    expect(await store.listCredIds(EMAIL)).toEqual([auth.id]);
    expect(await json(await me(get('/api/auth/me', jar)))).toMatchObject({ hasPasskey: true });

    // Challenge is single-use.
    const replay = await addVerify(jsonPost('/api/auth/passkey/add/verify', { response: new SoftAuthenticator({ origin: ORIGIN }).create(ob.options) }, jar));
    expect(await json(replay)).toMatchObject({ code: 'challenge_expired' });

    // Passkey login works.
    const lo = await loginOptions(jsonPost('/api/auth/login/options', { credentialIds: [auth.id] }));
    const ljar = new CookieJar().absorb(lo);
    const lr = await loginVerify(jsonPost('/api/auth/login/verify', { response: auth.get((await json(lo)).options) }, ljar));
    expect(lr.status).toBe(200);
    expect((await json(lr)).credentialId).toBe(auth.id);
  });

  it('rejects a cross-platform authenticator (phone via QR / security key) with not_platform', async () => {
    const jar = await registeredByEmail();
    const ob = await json(await addOptions(jsonPost('/api/auth/passkey/add/options', {}, jar)));
    const v = await addVerify(jsonPost('/api/auth/passkey/add/verify', { response: new SoftAuthenticator({ origin: ORIGIN, attachment: 'cross-platform' }).create(ob.options) }, jar));
    expect(v.status).toBe(400);
    expect(await json(v)).toMatchObject({ ok: false, code: 'not_platform' });
    expect(await store.listCredIds(EMAIL)).toEqual([]);
  });

  it('rejects a wrong origin and a credential already registered', async () => {
    const jar = await registeredByEmail();
    const ob = await json(await addOptions(jsonPost('/api/auth/passkey/add/options', {}, jar)));
    const evil = await addVerify(jsonPost('/api/auth/passkey/add/verify', { response: new SoftAuthenticator({ origin: 'https://evil.example' }).create(ob.options) }, jar));
    expect(await json(evil)).toMatchObject({ code: 'verification_failed' });

    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const o1 = await json(await addOptions(jsonPost('/api/auth/passkey/add/options', {}, jar)));
    expect((await addVerify(jsonPost('/api/auth/passkey/add/verify', { response: auth.create(o1.options) }, jar))).status).toBe(200);
    const o2 = await json(await addOptions(jsonPost('/api/auth/passkey/add/options', {}, jar)));
    expect(o2.options.excludeCredentials).toEqual([expect.objectContaining({ id: auth.id })]);
    const dup = await addVerify(jsonPost('/api/auth/passkey/add/verify', { response: auth.create(o2.options) }, jar));
    expect(dup.status).toBe(409);
    expect(await json(dup)).toMatchObject({ code: 'credential_exists' });
  });
});
