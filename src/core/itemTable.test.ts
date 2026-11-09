import { describe, expect, it } from 'vitest';
import { buildItemTable, itemTableRows, parseQty } from './itemTable';
import type { AreaMeasurement, Calibration, Category } from './types';

const cal: Calibration = { pixelsPerMeter: 10, p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, meters: 1 };
const cats: Category[] = [
  { id: 'win', name: 'חלונות', color: '#00f' },
  { id: 'cw', name: 'קירות מסך', color: '#0f0' },
];
const rect = (x: number, y: number, w: number, h: number) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const ms: AreaMeasurement[] = [
  { id: 'c1', page: 1, kind: 'count', label: 'פריט 1', color: '#000', category: 'win', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], item: { width: 1.5, height: 1.4, code: 'W1' }, system: 'קליל 7000' },
  { id: 'c2', page: 1, kind: 'count', label: 'פריט 2', color: '#000', category: 'win', points: [{ x: 1, y: 1 }], itemName: 'W2', qtyText: '4', extra: 'זיגוג כפול' },
  // curtain wall: 4 m × 9.4 m area marked as an item, with a 1×1 m opening inside
  { id: 'a1', page: 1, kind: 'area', label: 'חזית 1', color: '#000', category: 'cw', points: rect(0, 0, 40, 94), asItem: true, itemName: 'CW-1', system: 'קיר מסך סטיק' },
  { id: 'd1', page: 1, kind: 'deduct', label: 'פתח 1', color: '#000', points: rect(5, 5, 10, 10) },
  // area NOT marked as item → not in the table
  { id: 'a2', page: 1, kind: 'area', label: 'חזית 2', color: '#000', points: rect(100, 0, 10, 10) },
  // marked area on an uncalibrated page
  { id: 'a3', page: 2, kind: 'area', label: 'חזית 3', color: '#000', points: rect(0, 0, 10, 10), asItem: true },
];

describe('items table', () => {
  const t = buildItemTable(ms, { 1: cal }, cats);
  it('groups items by category in category order, uncategorised last, with subtotals', () => {
    expect(t.groups.map((g) => g.name)).toEqual(['חלונות', 'קירות מסך', 'ללא קטגוריה']);
    const win = t.groups[0];
    expect(win.rows.map((r) => [r.name, r.size, r.qtyText, r.system, r.extra])).toEqual([
      ['W1', '150×140 (2.10 מ״ר)', '3', 'קליל 7000', ''],
      ['W2', '', '4', '', 'זיגוג כפול'],
    ]);
    expect(win.subtotal.units).toBe(7);
    expect(win.subtotal.m2).toBeCloseTo(3 * 1.5 * 1.4, 6); // measured windows add their glazing area
  });
  it('turns a measured area into an item with net m² and its size', () => {
    const cw = t.groups[1].rows[0];
    expect(cw.name).toBe('CW-1');
    expect(cw.size).toBe('4.00×9.40');
    expect(cw.qty).toBeCloseTo(37.6 - 1, 5); // 4×9.4 minus the 1×1 opening
    expect(cw.qtyText).toBe('36.60 מ״ר');
    expect(t.groups[1].subtotal.m2).toBeCloseTo(36.6, 5);
  });
  it('excludes unmarked areas and flags uncalibrated ones', () => {
    expect(t.groups.flatMap((g) => g.rows).some((r) => r.id === 'a2')).toBe(false);
    expect(t.uncalibrated).toBe(1);
    expect(t.groups[2].rows[0].qtyText).toBe('לא מכויל');
  });
  it('builds export rows in the owner\'s column order with category subtotals', () => {
    const rows = itemTableRows(t);
    expect(rows[0]).toEqual(['שם פריט', 'קטגוריה', 'מערכת', 'גודל', 'כמות', 'מידע נוסף']);
    expect(rows).toContainEqual(['סה״כ חלונות', 'חלונות', '', '', '7 יח׳ · 6.30 מ״ר', '']);
    expect(rows).toContainEqual(['סה״כ קירות מסך', 'קירות מסך', '', '', '36.60 מ״ר', '']);
    expect(rows[rows.length - 1][0]).toBe('סה״כ כללי');
  });
  it('parses free-text quantities', () => {
    expect(parseQty('12')).toBe(12);
    expect(parseQty('3,5 מ״ר')).toBe(3.5);
    expect(parseQty('1,234.5')).toBe(1234.5);
    expect(parseQty('לפי מדידה')).toBeNull();
  });
});
