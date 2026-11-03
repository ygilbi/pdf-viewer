import { describe, expect, it } from 'vitest';
import type { AreaMeasurement, Calibration, Category, Point } from '../core/types';
import {
  autoUnit,
  buildBoq,
  describeQuantity,
  emptyPriceBook,
  formatMoney,
  resolvePricing,
  round2,
  sanitizePriceBook,
  type PriceBook,
  type ResolvedPricing,
} from './boq';

const P = (x: number, y: number): Point => ({ x, y });
/** w×h meters rectangle at 10 units / m, offset (ox, oy) in units. */
const rect = (w: number, h: number, ox = 0, oy = 0): Point[] => [
  P(ox, oy),
  P(ox + w * 10, oy),
  P(ox + w * 10, oy + h * 10),
  P(ox, oy + h * 10),
];
const cal: Calibration = { pixelsPerMeter: 10, p1: P(0, 0), p2: P(100, 0), meters: 10 };
const cats: Category[] = [
  { id: 'clad', name: 'חיפוי', color: '#ff7f0e' },
  { id: 'win', name: 'חלונות', color: '#1f77b4' },
  { id: 'rail', name: 'מעקות', color: '#8c564b' },
  { id: 'unused', name: 'ריק', color: '#000000' },
];
const pts = (n: number) => Array.from({ length: n }, (_, i) => P(i, i));

const ms: AreaMeasurement[] = [
  // cladding facade 24×14 = 336 m² with a 2×1.5 uncategorised opening → net 333
  { id: 'f', page: 1, kind: 'area', label: 'חזית', points: rect(24, 14), color: '#000', category: 'clad' },
  { id: 'o', page: 1, kind: 'deduct', label: 'פתח', points: rect(2, 1.5, 20, 20), color: '#000' },
  // windows drawn as openings inside the cladding (own category) → priced as windows by area
  { id: 'w', page: 1, kind: 'deduct', label: 'חלון', points: rect(1, 1, 100, 20), color: '#000', category: 'win' },
  // + a count group with item dims: 12 × 1.5×1.4
  { id: 'n', page: 1, kind: 'count', label: 'W1', points: pts(12), color: '#000', category: 'win', item: { width: 1.5, height: 1.4, code: 'W1' } },
  // railing length 7.5 m
  { id: 'l', page: 1, kind: 'length', label: 'מעקה', points: [P(0, 0), P(75, 0)], color: '#000', category: 'rail' },
  // uncalibrated page: excluded with a warning
  { id: 'u', page: 2, kind: 'area', label: 'חזית 2', points: rect(5, 5), color: '#000', category: 'clad' },
  // markup is ignored
  { id: 'k', page: 1, kind: 'note', label: 'הערה', points: [P(1, 1)], color: '#000', text: 'x', category: 'clad' },
];

const pricing = (doc: Partial<PriceBook> = {}, global: Partial<PriceBook> = {}): ResolvedPricing =>
  resolvePricing({ ...emptyPriceBook(), ...global }, { ...emptyPriceBook(), ...doc });

describe('round2', () => {
  it('rounds half away from zero, tolerant of binary noise', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(-0.001)).toBe(0);
    expect(Object.is(round2(-0.001), -0)).toBe(false);
    expect(round2(NaN)).toBe(0);
  });
});

describe('buildBoq', () => {
  const book = pricing({
    categories: {
      clad: { price: 450, wastePct: 10 },
      win: { price: 1200.5, labour: 150, unit: 'm2' },
      rail: { price: 800, wastePct: 5 },
    },
    settings: { discountPct: 5, vatPct: 18, projectName: 'מגדל א', client: 'לקוח' },
  });
  const boq = buildBoq({ measurements: ms, calibrations: { 1: cal }, categories: cats, pricing: book });

  it('one line per non-empty category, in category order', () => {
    expect(boq.lines.map((l) => l.category)).toEqual(['clad', 'win', 'rail']);
  });

  it('cladding: net m², waste, price', () => {
    const l = boq.lines[0];
    expect(l.unit).toBe('m2');
    expect(l.unitIsAuto).toBe(true);
    expect(l.quantity).toBe(332); // 336 − 3 (opening) − 1 (window opening, priced under windows)
    expect(l.wastePct).toBe(10);
    expect(l.quantityWithWaste).toBe(365.2);
    expect(l.total).toBe(164340);
  });

  it('windows: own openings + item area, labour added to the unit price', () => {
    const l = boq.lines[1];
    expect(l.unit).toBe('m2');
    expect(l.unitIsAuto).toBe(false);
    expect(l.breakdown.openingsM2).toBeCloseTo(1, 9);
    expect(l.breakdown.itemAreaM2).toBeCloseTo(25.2, 9);
    expect(l.quantity).toBe(26.2);
    expect(l.quantityWithWaste).toBe(26.2);
    expect(l.total).toBe(round2(26.2 * 1350.5)); // 35383.1
    expect(describeQuantity(l.unit, l.breakdown)).toBe('פתחים 1.00 + פריטים 25.20');
  });

  it('railings: auto unit m′, waste rounded to 2 dp', () => {
    const l = boq.lines[2];
    expect(l.unit).toBe('m');
    expect(l.quantity).toBe(7.5);
    expect(l.quantityWithWaste).toBe(7.88); // 7.875 → 7.88
    expect(l.total).toBe(6304);
  });

  it('subtotal, discount, VAT, total', () => {
    const sub = round2(boq.lines.reduce((n, l) => n + l.total, 0));
    expect(boq.subtotal).toBe(sub);
    expect(boq.discountPct).toBe(5);
    expect(boq.discount).toBe(round2(sub * 0.05));
    expect(boq.afterDiscount).toBe(round2(sub - boq.discount));
    expect(boq.vat).toBe(round2(boq.afterDiscount * 0.18));
    expect(boq.total).toBe(round2(boq.afterDiscount + boq.vat));
    expect(boq.projectName).toBe('מגדל א');
    expect(boq.currency).toBe('₪');
  });

  it('uncalibrated pages excluded with a warning naming the category', () => {
    expect(boq.uncalibrated).toBe(1);
    expect(boq.warnings[0]).toContain('לא מכוילים');
    expect(boq.warnings[0]).toContain('חיפוי');
    expect(boq.unpriced).toBe(0);
  });

  it('page filter, empty categories hidden, unpriced warning', () => {
    const only2 = buildBoq({ measurements: ms, calibrations: { 1: cal }, categories: cats, pricing: pricing(), pages: [2] });
    expect(only2.lines).toEqual([]); // the only measurement there is uncalibrated
    expect(only2.total).toBe(0);
    expect(only2.uncalibrated).toBe(1);
    const p1 = buildBoq({ measurements: ms, calibrations: { 1: cal }, categories: cats, pricing: pricing(), pages: [1] });
    expect(p1.lines).toHaveLength(3);
    expect(p1.uncalibrated).toBe(0);
    expect(p1.unpriced).toBe(3);
    expect(p1.warnings).toEqual(['3 שורות ללא מחיר']);
    expect(p1.vatPct).toBe(18); // default
  });

  it('count-only category defaults to units; uncategorised gets its own line', () => {
    const b = buildBoq({
      measurements: [
        { id: 'a', page: 5, kind: 'count', label: 'D1', points: pts(3), color: '#000' },
        { id: 'b', page: 5, kind: 'count', label: 'W2', points: pts(4), color: '#000', category: 'win' },
      ],
      calibrations: {},
      categories: cats,
      pricing: pricing({ categories: { '': { price: 10 }, win: { price: 2.5, wastePct: 0 } } }),
    });
    expect(b.lines.map((l) => [l.name, l.unit, l.quantity, l.total])).toEqual([
      ['חלונות', 'unit', 4, 10],
      ['ללא קטגוריה', 'unit', 3, 30],
    ]);
    expect(b.uncalibrated).toBe(0); // counts need no calibration
    expect(b.subtotal).toBe(40);
    expect(b.vat).toBe(7.2);
    expect(b.total).toBe(47.2);
  });

  it('a unit override with no matching quantity yields 0, discount clamps to 100%', () => {
    const b = buildBoq({
      measurements: ms.slice(4, 5),
      calibrations: { 1: cal },
      categories: cats,
      pricing: pricing({ categories: { rail: { unit: 'unit', price: 99 } }, settings: { discountPct: 150 } }),
    });
    expect(b.lines[0].quantity).toBe(0);
    expect(b.lines[0].total).toBe(0);
    expect(b.discountPct).toBe(100);
  });
});

describe('price book', () => {
  it('document overrides win field-wise over the global book', () => {
    const r = pricing(
      { categories: { win: { price: 900 } }, settings: { vatPct: 17 } },
      { categories: { win: { price: 800, wastePct: 3 }, clad: { price: 400 } }, settings: { discountPct: 2 } },
    );
    expect(r.categories.win).toEqual({ price: 900, wastePct: 3 });
    expect(r.categories.clad).toEqual({ price: 400 });
    expect(r.settings).toMatchObject({ vatPct: 17, discountPct: 2, currency: '₪' });
  });

  it('sanitizePriceBook drops garbage', () => {
    expect(sanitizePriceBook(null)).toBeNull();
    expect(sanitizePriceBook('x')).toBeNull();
    expect(
      sanitizePriceBook({
        categories: { a: { price: -1, wastePct: 5, unit: 'kg' }, b: 'x', c: { price: 7, unit: 'm' }, d: {} },
        settings: { vatPct: 'x', discountPct: 200, currency: ' $ ', client: 'c' },
      }),
    ).toEqual({ categories: { a: { wastePct: 5 }, c: { price: 7, unit: 'm' } }, settings: { currency: '$', client: 'c' } });
  });

  it('autoUnit + formatMoney', () => {
    expect(autoUnit({ area: 0, length: 0, count: 0 })).toBe('m2');
    expect(autoUnit({ area: 1, length: 1, count: 1 })).toBe('m2');
    expect(autoUnit({ area: 0, length: 2, count: 2 })).toBe('m');
    expect(autoUnit({ area: 1, length: 0, count: 2 })).toBe('unit');
    expect(formatMoney(1234.5)).toBe('₪ 1,234.50');
  });
});
