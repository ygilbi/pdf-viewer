import { describe, expect, it } from 'vitest';
import { buildAlooTsv } from './alooClipboard';
import type { GilboaPayload } from './gilboaExport';

/**
 * ALOO's paste parser, reduced to the rules that matter for this table (copied from
 * aluminum-app src/features/takeoff/takeoff.ts · parseTakeoffText, branch "aloo").
 */
const KINDS: Record<string, string> = { שטח: 'area', ניכוי: 'deduct', פתח: 'deduct', אורך: 'length', ספירה: 'count' };
const num = (s: unknown) => {
  const t = String(s ?? '').replace(/[^\d.-]/g, '');
  return !t || t === '-' || t === '.' ? null : Number(t);
};
function alooParse(text: string) {
  const rows = text.trim().split(/\r?\n/).map((l) => l.split('\t'));
  const hi = rows.findIndex((r) => r.some((c) => c.trim() === 'סוג') && r.some((c) => c.trim() === 'שם'));
  if (hi < 0) return null;
  const head = rows[hi].map((c) => c.trim());
  const col = (name: string) => head.findIndex((h) => h.startsWith(name));
  const c = { kind: col('סוג'), label: col('שם'), category: col('קטגוריה'), page: col('עמוד'), area: col('שטח'), perim: col('היקף'), length: col('אורך'), count: col('כמות'), width: col('רוחב'), height: col('גובה') };
  return rows.slice(hi + 1).flatMap((r) => {
    const kind = KINDS[(r[c.kind] ?? '').trim()];
    if (!kind) return [];
    return [{ kind, label: r[c.label].trim(), category: r[c.category].trim(), page: num(r[c.page]), areaM2: num(r[c.area]), perimeterM: num(r[c.perim]), lengthM: num(r[c.length]), count: num(r[c.count]), widthM: num(r[c.width]), heightM: num(r[c.height]) }];
  });
}

const payload: GilboaPayload = {
  v: 1,
  source: 'pdf-takeoff',
  file: 'a.pdf',
  measurements: [
    { kind: 'deduct', label: 'חלון\t1', category: 'חלונות', page: 2, areaM2: 2.4, perimeterM: 6.4, lengthM: null, count: null, widthM: 1.2, heightM: 2 },
    { kind: 'length', label: 'מעקה', category: 'מעקות', page: 1, areaM2: null, perimeterM: null, lengthM: 12.345, count: null, widthM: null, heightM: null },
    { kind: 'count', label: 'תריס', category: '', page: 3, areaM2: null, perimeterM: null, lengthM: null, count: 7, widthM: null, heightM: null },
    { kind: 'area', label: 'קיר מסך', category: 'קירות מסך', page: 1, areaM2: 31.5, perimeterM: 24, lengthM: null, count: null, widthM: 7, heightM: 4.5 },
  ],
};

describe('ALOO clipboard table', () => {
  it('round-trips through ALOO\'s paste parser with exact sizes', () => {
    const parsed = alooParse(buildAlooTsv(payload))!;
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toEqual({ kind: 'deduct', label: 'חלון 1', category: 'חלונות', page: 2, areaM2: 2.4, perimeterM: 6.4, lengthM: null, count: null, widthM: 1.2, heightM: 2 });
    expect(parsed[1]).toMatchObject({ kind: 'length', lengthM: 12.345 });
    expect(parsed[2]).toMatchObject({ kind: 'count', count: 7, category: '' });
    expect(parsed[3]).toMatchObject({ kind: 'area', areaM2: 31.5, widthM: 7, heightM: 4.5 });
  });
  it('one row per item plus the header, tab separated', () => {
    const lines = buildAlooTsv(payload).trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0].split('\t')).toHaveLength(11);
  });
});
