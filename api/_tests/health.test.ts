import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as health } from '../_routes/health.js';
import { describeSmtpError, setMailerForTests } from '../_lib/mailer.js';
import { createMemoryStore, setStoreForTests, type Store } from '../_lib/store.js';
import { BASE_ENV, fakeMailer, get, setEnv } from './helpers.js';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function mockGitHub(status = 200) {
  const releases = [{ tag_name: 'desktop-v0.2.0', draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', created_at: '', assets: [{ id: 6, name: 'PDF-Viewer-Setup-0.2.0.exe' }] }];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(releases), { status })));
}

beforeEach(() => {
  setEnv();
  setMailerForTests(fakeMailer());
  setStoreForTests(createMemoryStore());
});

afterEach(() => {
  setMailerForTests(null);
  setStoreForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/health', () => {
  it('reports everything ok, without leaking secret values', async () => {
    mockGitHub();
    const res = await health(get('/api/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as J;
    expect(body).toEqual({
      ok: true,
      env: { OWNER_EMAIL: true, SMTP_USER: true, SMTP_PASS: true, SIGNING_SECRET: true, GITHUB_TOKEN: true, KV: true },
      smtp: 'ok',
      redis: 'ok',
      github: 'ok',
      installer: 'desktop-v0.2.0/PDF-Viewer-Setup-0.2.0.exe',
      rpId: 'app.example.test',
      rpIdMatchesHost: true,
    });
    const text = JSON.stringify(body);
    for (const k of ['SIGNING_SECRET', 'SMTP_PASS', 'GITHUB_TOKEN', 'KV_REST_API_TOKEN', 'OWNER_EMAIL', 'SMTP_USER']) {
      expect(text).not.toContain(BASE_ENV[k]);
    }
  });

  it('shows what is missing or broken', async () => {
    setEnv({ SMTP_PASS: undefined, GITHUB_TOKEN: undefined, SIGNING_SECRET: 'short', KV_REST_API_URL: undefined, OWNER_EMAIL: undefined, APP_URL: undefined });
    setStoreForTests(null);
    const body = (await (await health(get('/api/health'))).json()) as J;
    expect(body.ok).toBe(false);
    expect(body.env).toEqual({ OWNER_EMAIL: false, SMTP_USER: true, SMTP_PASS: false, SIGNING_SECRET: false, GITHUB_TOKEN: false, KV: false });
    expect(body.smtp).toBe('skipped');
    expect(body.redis).toBe('missing');
    expect(body.github).toBe('missing');
    expect(body.rpId).toBe('app.example.test'); // from the request host
  });

  it('reports SMTP auth failures, Redis errors and GitHub status codes', async () => {
    mockGitHub(401);
    setMailerForTests(fakeMailer(Object.assign(new Error('Invalid login: 535 secret text'), { code: 'EAUTH', responseCode: 535 })));
    setStoreForTests({ ping: async () => Promise.reject(new Error('down')) } as unknown as Store);
    const body = (await (await health(get('/api/health'))).json()) as J;
    expect(body.smtp).toBe('error: auth failed 535');
    expect(body.redis).toBe('error');
    expect(body.github).toBe('error 401');
    expect(JSON.stringify(body)).not.toContain('secret text');
  });

  it('describeSmtpError maps common nodemailer errors', () => {
    expect(describeSmtpError({ code: 'EAUTH' })).toBe('auth failed');
    expect(describeSmtpError({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(describeSmtpError({ code: 'ECONNREFUSED' })).toBe('connection failed (ECONNREFUSED)');
    expect(describeSmtpError({ code: 'EDNS' })).toBe('host not found');
    expect(describeSmtpError(new Error('x'))).toBe('failed');
  });
});
