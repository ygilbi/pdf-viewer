import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as requestAccess } from '../request-access.js';
import { GET as approveGet, POST as approvePost } from '../approve.js';
import { GET as denyGet, POST as denyPost } from '../deny.js';
import { GET as download } from '../download.js';
import { setMailerForTests } from '../_lib/mailer.js';
import { signToken, nowSeconds, verifyToken } from '../_lib/token.js';
import { esc } from '../_lib/templates.js';
import { pickInstaller } from '../_lib/github.js';
import { SECRET, fakeMailer, freshIp, linkTo, setEnv } from './helpers.js';

let mailer: ReturnType<typeof fakeMailer>;

beforeEach(() => {
  setEnv();
  mailer = fakeMailer();
  setMailerForTests(mailer);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setMailerForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://app.example.test/api/request-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const valid = { name: 'דנה כהן', email: 'dana@example.test', company: 'אקמה', message: 'שלום\nאשמח להוריד' };

async function submitAndGetApproveToken(): Promise<{ approveUrl: string; denyUrl: string; token: string }> {
  const res = await requestAccess(post(valid));
  expect(res.status).toBe(200);
  const ownerMail = mailer.sent.find((m) => m.to === 'owner@example.test')!;
  const approveUrl = linkTo(ownerMail.html, '/api/approve?t=');
  const denyUrl = linkTo(ownerMail.html, '/api/deny?t=');
  mailer.sent.length = 0;
  return { approveUrl, denyUrl, token: new URL(approveUrl).searchParams.get('t')! };
}

describe('POST /api/request-access', () => {
  it('emails the owner approve/deny links and acknowledges the requester', async () => {
    const res = await requestAccess(post(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mailer.sent).toHaveLength(2);

    const [owner, ack] = mailer.sent;
    expect(owner.to).toBe('owner@example.test');
    expect(owner.replyTo).toBe('dana@example.test');
    expect(owner.html).toContain('dir="rtl"');
    expect(owner.html).toContain('אשר הורדה');
    expect(owner.html).toContain('דחה');
    expect(owner.html).toContain('אקמה');
    const approveUrl = linkTo(owner.html, '/api/approve?t=');
    const denyUrl = linkTo(owner.html, '/api/deny?t=');
    expect(approveUrl.startsWith('https://app.example.test/api/approve?t=')).toBe(true);
    expect(denyUrl.startsWith('https://app.example.test/api/deny?t=')).toBe(true);
    expect(owner.text).toContain(approveUrl);
    expect(owner.text).toContain(denyUrl);

    const v = verifyToken(new URL(approveUrl).searchParams.get('t'), SECRET, 'approve');
    expect(v.ok && v.payload).toMatchObject({ t: 'approve', name: 'דנה כהן', email: 'dana@example.test', company: 'אקמה' });
    if (v.ok) expect(v.payload.exp - v.payload.iat).toBe(14 * 86400);

    expect(ack.to).toBe('dana@example.test');
    expect(ack.subject + ack.html).toContain('התקבלה');
    expect(ack.html).not.toContain('דנה'); // no user-supplied text in mail sent to an unverified address
  });

  it('derives the base URL from forwarded headers when APP_URL is unset', async () => {
    setEnv({ APP_URL: undefined });
    await requestAccess(post(valid, { host: 'pdf.example.org', 'x-forwarded-proto': 'https' }));
    expect(linkTo(mailer.sent[0].html, '/api/approve?t=')).toMatch(/^https:\/\/pdf\.example\.org\/api\/approve\?t=/);
  });

  it('can skip the requester acknowledgement', async () => {
    setEnv({ SEND_REQUESTER_ACK: 'false' });
    await requestAccess(post(valid));
    expect(mailer.sent.map((m) => m.to)).toEqual(['owner@example.test']);
  });

  it('silently accepts honeypot submissions without sending mail', async () => {
    const res = await requestAccess(post({ ...valid, website: 'http://spam.example' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mailer.sent).toHaveLength(0);
  });

  it.each([
    [{ ...valid, name: 'x' }, 'name'],
    [{ ...valid, name: 'a'.repeat(81) }, 'name'],
    [{ ...valid, name: 'Dana\r\nBcc: x@evil.test' }, 'name'],
    [{ ...valid, email: 'not-an-email' }, 'email'],
    [{ ...valid, email: 'dana@example.test\r\nBcc: x@evil.test' }, 'email'],
    [{ ...valid, email: `${'a'.repeat(195)}@ex.test` }, 'email'],
    [{ ...valid, message: 'm'.repeat(1001) }, 'message'],
    [{ email: 'dana@example.test' }, 'name'],
  ])('rejects invalid input %#', async (body, field) => {
    const res = await requestAccess(post(body));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; code: string; error: string; fields: Record<string, string> };
    expect(json.ok).toBe(false);
    expect(json.fields).toHaveProperty(field);
    expect(json).toMatchObject({ code: 'validation', error: expect.stringMatching(/[\u0590-\u05FF]/) });
    expect(mailer.sent).toHaveLength(0);
  });

  it('trims fields', async () => {
    await requestAccess(post({ name: '  דנה  ', email: ' dana@example.test ' }));
    const v = verifyToken(new URL(linkTo(mailer.sent[0].html, '/api/approve?t=')).searchParams.get('t'), SECRET, 'approve');
    expect(v.ok && v.payload).toMatchObject({ name: 'דנה', email: 'dana@example.test' });
  });

  it('rejects bodies over 8 KB and bad JSON', async () => {
    const big = await requestAccess(post({ ...valid, message: 'x'.repeat(9000) }));
    expect(big.status).toBe(413);
    const bad = await requestAccess(post('{nope'));
    expect(bad.status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });

  it('rate-limits repeated requests from one IP', async () => {
    const ip = '198.51.100.7';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await requestAccess(post(valid, { 'x-forwarded-for': ip }))).status);
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('fails closed when SIGNING_SECRET is missing or too short', async () => {
    for (const secret of [undefined, 'short']) {
      setEnv({ SIGNING_SECRET: secret });
      const res = await requestAccess(post(valid));
      expect(res.status).toBe(500);
      expect(((await res.json()) as { code: string }).code).toBe('server_config');
    }
    expect(mailer.sent).toHaveLength(0);
  });

  it('reports a mail failure', async () => {
    setMailerForTests({ send: async () => Promise.reject(new Error('smtp down')) });
    const res = await requestAccess(post(valid));
    expect(res.status).toBe(502);
  });

  it('escapes HTML in user input (XSS)', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await requestAccess(post({ ...valid, name: `${evil}ab`, company: '"><script>x</script>', message: evil }));
    const owner = mailer.sent[0];
    expect(owner.html).not.toContain('<img src=x');
    expect(owner.html).not.toContain('<script>');
    expect(owner.html).toContain(esc(evil));

    const approveUrl = linkTo(owner.html, '/api/approve?t=');
    const page = await (await approveGet(new Request(approveUrl))).text();
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('<script>');
    expect(page).toContain('&lt;img src=x');
  });
});

describe('/api/approve', () => {
  it('GET shows a confirmation page with a POST form and sends no mail', async () => {
    const { approveUrl } = await submitAndGetApproveToken();
    const res = await approveGet(new Request(approveUrl));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await res.text();
    expect(html).toContain('dir="rtl"');
    expect(html).toMatch(/<form method="post" action="\/api\/approve\?t=[\w%-]+\.[\w%-]+">/);
    expect(html).toContain('אשר ושלח קישור הורדה');
    expect(html).toContain('dana@example.test');
    expect(mailer.sent).toHaveLength(0);
  });

  it('POST emails the requester a download link and confirms to the owner', async () => {
    setEnv({ DOWNLOAD_LINK_DAYS: '5' });
    const { approveUrl } = await submitAndGetApproveToken();
    const res = await approvePost(new Request(approveUrl, { method: 'POST' }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ההורדה אושרה');
    expect(html).toContain('נשלח מייל אל');
    expect(html).toContain('dana@example.test');

    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0];
    expect(m.to).toBe('dana@example.test');
    expect(m.html).toContain('הורד את PDF Viewer ל-Windows');
    expect(m.html).toContain('More info');
    expect(m.html).toContain('Run anyway');
    expect(m.html).toContain('5 ימים');
    const dlUrl = linkTo(m.html, '/api/download?t=');
    expect(dlUrl.startsWith('https://app.example.test/api/download?t=')).toBe(true);
    const v = verifyToken(new URL(dlUrl).searchParams.get('t'), SECRET, 'download');
    expect(v.ok && v.payload).toMatchObject({ t: 'download', email: 'dana@example.test', name: 'דנה כהן' });
    if (v.ok) expect(v.payload.exp - v.payload.iat).toBe(5 * 86400);
  });

  it('rejects expired, tampered and wrong-type tokens without sending mail', async () => {
    const now = nowSeconds();
    const expired = signToken({ t: 'approve', name: 'דנה', email: 'd@example.test', iat: now - 100, exp: now - 1 }, SECRET);
    const dl = signToken({ t: 'download', name: 'דנה', email: 'd@example.test', iat: now, exp: now + 100 }, SECRET);
    for (const t of [expired, dl, 'garbage', `${expired}x`]) {
      const url = `https://app.example.test/api/approve?t=${encodeURIComponent(t)}`;
      const g = await approveGet(new Request(url));
      expect(g.status).toBe(400);
      expect(await g.text()).toContain('הקישור אינו תקף');
      const p = await approvePost(new Request(url, { method: 'POST' }));
      expect(p.status).toBe(400);
    }
    const missing = await approveGet(new Request('https://app.example.test/api/approve'));
    expect(missing.status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('/api/deny', () => {
  it('GET confirms only; POST declines without emailing by default', async () => {
    const { denyUrl } = await submitAndGetApproveToken();
    const g = await denyGet(new Request(denyUrl));
    const gHtml = await g.text();
    expect(gHtml).toMatch(/<form method="post" action="\/api\/deny\?t=/);
    expect(mailer.sent).toHaveLength(0);

    const p = await denyPost(new Request(denyUrl, { method: 'POST' }));
    expect(p.status).toBe(200);
    expect(await p.text()).toContain('הבקשה נדחתה');
    expect(mailer.sent).toHaveLength(0);
  });

  it('POST emails a polite decline when SEND_DENY_EMAIL=true', async () => {
    setEnv({ SEND_DENY_EMAIL: 'true' });
    const { denyUrl } = await submitAndGetApproveToken();
    await denyPost(new Request(denyUrl, { method: 'POST' }));
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('dana@example.test');
    expect(mailer.sent[0].html).toContain('לא נוכל לאשר');
    expect(mailer.sent[0].html).not.toContain('/api/download');
  });
});

// ------------------------------------------------------------------ download

const releases = [
  { tag_name: 'v9.9.9', draft: false, prerelease: false, published_at: '2026-10-30T00:00:00Z', created_at: '2026-10-30T00:00:00Z', assets: [{ id: 1, name: 'PDF-Viewer-Setup-9.9.9.exe' }] },
  { tag_name: 'desktop-v0.3.0', draft: true, prerelease: false, published_at: null, created_at: '2026-10-29T00:00:00Z', assets: [{ id: 2, name: 'PDF-Viewer-Setup-0.3.0.exe' }] },
  { tag_name: 'desktop-v0.1.0', draft: false, prerelease: false, published_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z', assets: [{ id: 3, name: 'PDF-Viewer-Setup-0.1.0.exe' }] },
  { tag_name: 'desktop-v0.2.0', draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', assets: [
    { id: 4, name: 'PDF-Viewer-Setup-0.2.0.exe.blockmap' },
    { id: 5, name: 'latest.yml' },
    { id: 6, name: 'PDF-Viewer-Setup-0.2.0.exe' },
  ] },
];

function mockGitHub(opts: { listStatus?: number; assetStatus?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('/releases?')) {
      return new Response(JSON.stringify(releases), { status: opts.listStatus ?? 200, headers: { 'content-type': 'application/json' } });
    }
    const id = u.match(/\/releases\/assets\/(\d+)$/)?.[1];
    if (id) {
      return new Response(null, {
        status: opts.assetStatus ?? 302,
        headers: { location: `https://objects.githubusercontent.example/signed/${id}?sig=abc` },
      });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function downloadToken(expDelta = 3 * 86400): string {
  const now = nowSeconds();
  return signToken({ t: 'download', name: 'דנה', email: 'dana@example.test', iat: now, exp: now + expDelta }, SECRET);
}

describe('GET /api/download', () => {
  it('redirects to the signed URL of the newest desktop-v* installer', async () => {
    const calls = mockGitHub();
    const res = await download(new Request(`https://app.example.test/api/download?t=${downloadToken()}`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://objects.githubusercontent.example/signed/6?sig=abc');
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(calls[0].url).toBe('https://api.github.com/repos/ygilbi/pdf-viewer/releases?per_page=50');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer github_pat_test');
    expect(calls[1].url).toBe('https://api.github.com/repos/ygilbi/pdf-viewer/releases/assets/6');
    expect((calls[1].init?.headers as Record<string, string>).Accept).toBe('application/octet-stream');
    expect(calls[1].init?.redirect).toBe('manual');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('email=dana@example.test'));
  });

  it('honours GITHUB_REPO', async () => {
    setEnv({ GITHUB_REPO: 'someone/other' });
    const calls = mockGitHub();
    await download(new Request(`https://app.example.test/api/download?t=${downloadToken()}`));
    expect(calls[0].url).toContain('/repos/someone/other/releases');
  });

  it('shows a Hebrew page linking to /download for expired or invalid tokens', async () => {
    const calls = mockGitHub();
    const expired = await download(new Request(`https://app.example.test/api/download?t=${downloadToken(-10)}`));
    expect(expired.status).toBe(410);
    const html = await expired.text();
    expect(html).toContain('תוקף הקישור פג');
    expect(html).toContain('href="https://app.example.test/download"');

    const now = nowSeconds();
    const approveTok = signToken({ t: 'approve', name: 'דנה', email: 'd@example.test', iat: now, exp: now + 100 }, SECRET);
    for (const t of ['bad', approveTok]) {
      const r = await download(new Request(`https://app.example.test/api/download?t=${encodeURIComponent(t)}`));
      expect(r.status).toBe(400);
      expect(r.headers.get('location')).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it('returns 502 when GitHub fails', async () => {
    mockGitHub({ listStatus: 401 });
    const r1 = await download(new Request(`https://app.example.test/api/download?t=${downloadToken()}`));
    expect(r1.status).toBe(502);
    mockGitHub({ assetStatus: 404 });
    const r2 = await download(new Request(`https://app.example.test/api/download?t=${downloadToken()}`));
    expect(r2.status).toBe(502);
  });

  it('fails closed without GITHUB_TOKEN', async () => {
    setEnv({ GITHUB_TOKEN: undefined });
    const r = await download(new Request(`https://app.example.test/api/download?t=${downloadToken()}`));
    expect(r.status).toBe(500);
  });
});

describe('pickInstaller', () => {
  it('prefers stable releases and skips releases without an installer', () => {
    const picked = pickInstaller([
      { tag_name: 'desktop-v0.5.0-beta', draft: false, prerelease: true, published_at: '2026-11-01T00:00:00Z', created_at: '', assets: [{ id: 10, name: 'PDF-Viewer-Setup-0.5.0-beta.exe' }] },
      { tag_name: 'desktop-v0.4.0', draft: false, prerelease: false, published_at: '2026-10-20T00:00:00Z', created_at: '', assets: [{ id: 11, name: 'notes.txt' }] },
      { tag_name: 'desktop-v0.3.0', draft: false, prerelease: false, published_at: '2026-10-10T00:00:00Z', created_at: '', assets: [{ id: 12, name: 'PDF-Viewer-Setup-0.3.0.exe' }] },
    ]);
    expect(picked).toEqual({ tag: 'desktop-v0.3.0', asset: { id: 12, name: 'PDF-Viewer-Setup-0.3.0.exe' } });
    expect(pickInstaller([])).toBeNull();
  });
});
