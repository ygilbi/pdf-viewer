import { describe, expect, it } from 'vitest';
import { REPORT_MAX_BYTES, byteLength, fileLabel, fitReport, formatCrumb, sanitizeCrumb, scrubText, sessionDump, type DiagReport } from './report';
import type { AliveMarker } from './crash';

const m: AliveMarker = { v: 1, sid: 'abc', start: 1000, hb: 5000, clean: false, errors: 1, lastError: 'failed to open plan-B.pdf', state: { tool: 'link', zoom: 250, ptrs: 2 } };

describe('scrubText / fileLabel', () => {
  it('removes file names, emails, blob URLs and query values', () => {
    const s = scrubText('שגיאה בפתיחת הקובץ Tower A floor 3.PDF from https://x.test/api/download?t=SECRET&x=1 by a@b.co blob:https://x/123-456');
    expect(s).not.toContain('floor');
    expect(s).toContain('<*.pdf>');
    expect(s).not.toContain('<<');
    expect(scrubText('open "My Plan v2.pdf" failed; also x.png')).toBe('open "<*.pdf>" failed; also <*.png>');
    expect(s).not.toContain('SECRET');
    expect(s).not.toContain('a@b.co');
    expect(s).toContain('blob:<url>');
  });

  it('truncates long text', () => {
    expect(scrubText('x'.repeat(5000)).length).toBeLessThanOrEqual(600);
    expect(scrubText('abcdef', 4)).toBe('abc…');
  });

  it('fileLabel keeps only length + extension', () => {
    expect(fileLabel('תוכנית קומה.pdf')).toBe('15ch.pdf');
    expect(fileLabel('noext')).toBe('5ch');
    expect(fileLabel(null)).toBe('');
  });
});

describe('sanitizeCrumb', () => {
  it('keeps flat primitives, drops objects/functions, rounds numbers', () => {
    const c = sanitizeCrumb({ t: 12.4, k: 'pdown', d: { n: 2, x: 1.23456, ok: true, nested: { a: 1 }, f: () => 1, inf: Infinity, msg: 'file.pdf' } });
    expect(c).toEqual({ t: 12, k: 'pdown', d: { n: 2, x: 1.235, ok: true, inf: null, msg: '<*.pdf>' } });
  });

  it('rejects malformed crumbs', () => {
    expect(sanitizeCrumb(null)).toBeNull();
    expect(sanitizeCrumb({ k: 'x' })).toBeNull();
    expect(sanitizeCrumb({ t: 1, k: 3 })).toBeNull();
  });

  it('caps key count and key length', () => {
    const d = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}${'z'.repeat(40)}`, i]));
    const c = sanitizeCrumb({ t: 1, k: 'k'.repeat(100), d })!;
    expect(c.k.length).toBe(32);
    expect(Object.keys(c.d!).length).toBe(20);
    expect(Object.keys(c.d!).every((k) => k.length <= 32)).toBe(true);
  });
});

describe('sessionDump / fitReport', () => {
  it('dumps a session with scrubbed last error and sanitized crumbs', () => {
    const d = sessionDump(m, [{ t: 4000, k: 'tool', d: { tool: 'link' } }, { bad: true }], 'crashed');
    expect(d.lastError).toBe('failed to open <*.pdf>');
    expect(d.crumbs).toHaveLength(1);
    expect(d.state).toEqual({ tool: 'link', zoom: 250, ptrs: 2 });
    expect(formatCrumb(d.crumbs[0], d.hb)).toBe('-1.0s tool tool=link');
  });

  it('shrinks oversized reports below the limit, dropping previous-session crumbs first', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ t: i, k: 'pdown', d: { msg: 'y'.repeat(250), i } }));
    const report: DiagReport = {
      v: 1,
      kind: 'crash',
      createdAt: 1,
      build: {},
      device: { userAgent: 'x' },
      sessions: [
        { ...sessionDump(m, many(300), 'crashed') },
        { ...sessionDump({ ...m, sid: 'prev' }, many(300), 'previous') },
        { ...sessionDump({ ...m, sid: 'cur' }, many(300), 'current') },
      ],
    };
    expect(byteLength(JSON.stringify(report))).toBeGreaterThan(REPORT_MAX_BYTES);
    const fitted = fitReport(report, 180 * 1024);
    expect(byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(180 * 1024);
    const crashed = fitted.sessions.find((s) => s.role === 'crashed')!;
    expect(crashed.crumbs).toHaveLength(300); // most valuable session untouched
    expect(fitted.sessions.find((s) => s.role === 'previous')!.crumbs.length).toBeLessThan(300);
    // newest crumbs survive
    const prev = fitted.sessions.find((s) => s.role === 'previous')!;
    expect(prev.crumbs.length === 0 || prev.crumbs[prev.crumbs.length - 1].d!.i === 299).toBe(true);
    expect(report.sessions[1].crumbs).toHaveLength(300); // input not mutated
  });
});
