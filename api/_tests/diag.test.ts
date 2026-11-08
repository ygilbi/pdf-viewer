import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST, MAX_REPORT_BYTES, RATE_MAX, REPORT_TTL_SECONDS, cleanJson, validateReport } from '../_routes/diag/report.js';
import { ROUTES } from '../router.js';
import { setMailerForTests } from '../_lib/mailer.js';
import { Store, createMemoryKv, setStoreForTests } from '../_lib/store.js';
import { BASE_ENV, fakeMailer, jsonPost, setEnv } from './helpers.js';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let mailer: ReturnType<typeof fakeMailer>;
let kv: ReturnType<typeof createMemoryKv>;
let now = 1_800_000_000_000;

function report(extra: Record<string, unknown> = {}) {
  const crumbs = Array.from({ length: 60 }, (_, i) => ({ t: 1000 + i * 100, k: i === 59 ? '<script>alert(1)</script>' : 'pdown', d: { n: 2, x: i, y: 5 } }));
  return {
    v: 1,
    kind: 'crash',
    createdAt: 1,
    build: { buildId: 'abc', asset: 'index-x.js' },
    device: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) <b>', screenW: 390, screenH: 844, dpr: 3, deviceMemory: null },
    sessions: [{ sid: 's', role: 'crashed', hb: 7000, clean: false, errors: 0, state: { tool: 'link', zoom: 400, ptrs: 2 }, crumbs }],
    ...extra,
  };
}

beforeEach(() => {
  setEnv();
  mailer = fakeMailer();
  setMailerForTests(mailer);
  kv = createMemoryKv(() => now);
  setStoreForTests(new Store(kv));
});

afterEach(() => {
  setMailerForTests(null);
  setStoreForTests(null);
});

describe('POST /api/diag/report', () => {
  it('is registered in the router', () => {
    expect(ROUTES['diag/report']?.POST).toBeTypeOf('function');
  });

  it('stores the report for 30 days and emails the owner an escaped summary with the last 40 crumbs', async () => {
    const res = await POST(jsonPost('/api/diag/report', report()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as J;
    expect(body).toMatchObject({ ok: true, stored: true, mailed: true });
    expect(body.id).toMatch(/^diag:\d{13}:[\w-]+$/);

    const saved = JSON.parse((await kv.get(body.id))!);
    expect(saved.report.sessions[0].crumbs).toHaveLength(60);
    expect(saved.user).toBeNull();
    now += (REPORT_TTL_SECONDS - 1) * 1000;
    expect(await kv.get(body.id)).not.toBeNull();
    now += 2000;
    expect(await kv.get(body.id)).toBeNull();

    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0];
    expect(m.to).toBe(BASE_ENV.OWNER_EMAIL);
    expect(m.subject).toContain('crash');
    expect(m.subject).toContain('iPhone');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).not.toContain('<b>');
    expect(m.text).toContain(body.id);
    // last 40 crumbs only: x=20 is the first included, x=19 is not
    expect(m.text).toContain('x=20 ');
    expect(m.text).not.toContain('x=19 ');
    expect(m.text).toContain('tool');
  });

  it('rejects oversized bodies (413) and malformed reports (400)', async () => {
    const big = report({ pad: 'x'.repeat(MAX_REPORT_BYTES) });
    expect((await POST(jsonPost('/api/diag/report', big))).status).toBe(413);
    expect((await POST(jsonPost('/api/diag/report', '{not json'))).status).toBe(400);
    const bad = await POST(jsonPost('/api/diag/report', { v: 1, kind: 'hack', sessions: [] }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as J).reason).toBe('bad_kind');
    expect(mailer.sent).toHaveLength(0);
  });

  it('rate-limits per IP via KV', async () => {
    const ip = { 'x-forwarded-for': '198.51.100.7' };
    for (let i = 0; i < RATE_MAX; i++) expect((await POST(jsonPost('/api/diag/report', report(), undefined, ip))).status).toBe(200);
    const res = await POST(jsonPost('/api/diag/report', report(), undefined, ip));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    // another IP is unaffected
    expect((await POST(jsonPost('/api/diag/report', report()))).status).toBe(200);
  });

  it('still succeeds when mail fails (report is stored)', async () => {
    setMailerForTests({ async send() { throw Object.assign(new Error('x'), { code: 'EAUTH' }); } });
    const body = (await (await POST(jsonPost('/api/diag/report', report()))).json()) as J;
    expect(body).toMatchObject({ ok: true, stored: true, mailed: false });
  });

  it('validateReport / cleanJson', () => {
    expect(validateReport(null)).toBe('not_object');
    expect(validateReport({ v: 2 })).toBe('bad_version');
    expect(validateReport({ v: 1, kind: 'manual', sessions: [{ crumbs: [{ t: 'x', k: 'a' }] }] })).toBe('bad_crumb');
    expect(validateReport({ v: 1, kind: 'manual', sessions: Array(7).fill({ crumbs: [] }) })).toBe('bad_sessions');
    expect(validateReport({ v: 1, kind: 'manual', sessions: [] })).toBeNull();
    const deep: J = {};
    let cur = deep;
    for (let i = 0; i < 10; i++) cur = cur.a = {};
    expect(JSON.stringify(cleanJson(deep))).toBe('{"a":{"a":{"a":{"a":{"a":{"a":null}}}}}}');
    expect((cleanJson('y'.repeat(5000)) as string).length).toBe(2001);
    expect(cleanJson(JSON.parse('{"__proto__":{"x":1},"ok":1}'))).toEqual({ ok: 1 });
    expect(cleanJson(NaN)).toBeNull();
  });
});
