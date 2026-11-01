import { describe, expect, it } from 'vitest';
import type { AreaMeasurement, Calibration, Point } from './types';
import {
  DEFAULT_CATEGORIES,
  MEASUREMENT_COLORS,
  assignDeductions,
  categoryKey,
  categoryName,
  computeCategorySummaries,
  minPoints,
  sanitizeCategories,
  centroid,
  computeDocumentSummary,
  computeNetAreas,
  computePageSummary,
  distanceToPolyline,
  kindOf,
  nextLabelNumber,
  polylineLengthMeters,
  polylineMidpoint,
  computePixelsPerMeter,
  distance,
  formatArea,
  formatLength,
  isSelfIntersecting,
  lengthMeters,
  measurementsToCSV,
  measurementsToTSV,
  buildMeasurementRows,
  nearestVertex,
  newId,
  parseLengthInput,
  pointInPolygon,
  polygonAreaM2,
  polygonAreaPx,
  polygonPerimeterMeters,
  snapAngle,
} from './measurementEngine';

const P = (x: number, y: number): Point => ({ x, y });
const PPM = 28.3465; // ~1:100 at 72pt/inch: 1 m = 10 mm on paper = 28.3465 pt

const rect = (w: number, h: number, s = 1, ox = 0, oy = 0): Point[] => [
  P(ox, oy),
  P(ox + w * s, oy),
  P(ox + w * s, oy + h * s),
  P(ox, oy + h * s),
];

describe('distance & calibration', () => {
  it('distance is euclidean', () => {
    expect(distance(P(0, 0), P(3, 4))).toBe(5);
    expect(distance(P(1, 1), P(1, 1))).toBe(0);
  });

  it('computePixelsPerMeter / lengthMeters roundtrip', () => {
    const p1 = P(100, 200);
    const p2 = P(100 + 10 * PPM, 200);
    const ppm = computePixelsPerMeter(p1, p2, 10);
    expect(ppm).toBeCloseTo(PPM, 9);
    expect(lengthMeters(p1, p2, ppm)).toBeCloseTo(10, 9);
    // diagonal reference
    const q1 = P(0, 0);
    const q2 = P(30, 40);
    const ppm2 = computePixelsPerMeter(q1, q2, 2.5);
    expect(ppm2).toBeCloseTo(20, 9);
    expect(lengthMeters(P(5, 5), P(25, 5), ppm2)).toBeCloseTo(1, 9);
  });

  it('throws Hebrew errors on bad input', () => {
    expect(() => computePixelsPerMeter(P(0, 0), P(10, 0), 0)).toThrow(/[֐-׿]/);
    expect(() => computePixelsPerMeter(P(0, 0), P(10, 0), -1)).toThrow(Error);
    expect(() => computePixelsPerMeter(P(0, 0), P(10, 0), NaN)).toThrow(Error);
    expect(() => computePixelsPerMeter(P(0, 0), P(10, 0), Infinity)).toThrow(Error);
    expect(() => computePixelsPerMeter(P(5, 5), P(5, 5 + 1e-8), 1)).toThrow(/[֐-׿]/);
  });
});

describe('area', () => {
  it('10m x 5m rectangle at known ppm = 50 m²', () => {
    const pts = rect(10, 5, PPM, 37, 91);
    expect(polygonAreaM2(pts, PPM)).toBeCloseTo(50, 9);
    expect(polygonAreaPx(pts)).toBeCloseTo(50 * PPM * PPM, 6);
    expect(polygonPerimeterMeters(pts, PPM)).toBeCloseTo(30, 9);
    expect(polygonPerimeterMeters(pts, PPM, false)).toBeCloseTo(25, 9);
  });

  it('triangle', () => {
    const tri = [P(0, 0), P(4, 0), P(0, 3)];
    expect(polygonAreaPx(tri)).toBeCloseTo(6, 12);
    expect(polygonAreaM2(tri, 2)).toBeCloseTo(1.5, 12);
    expect(polygonPerimeterMeters(tri, 1)).toBeCloseTo(12, 12);
  });

  it('clockwise and counter-clockwise give the same area', () => {
    const cw = rect(7, 3, PPM, 10, 10);
    const ccw = [...cw].reverse();
    expect(polygonAreaM2(cw, PPM)).toBeCloseTo(21, 9);
    expect(polygonAreaM2(ccw, PPM)).toBeCloseTo(21, 9);
    expect(polygonAreaPx(cw)).toBeGreaterThan(0);
  });

  it('concave L-shape', () => {
    // 10x10 square minus 5x5 corner = 75
    const L = [P(0, 0), P(10, 0), P(10, 5), P(5, 5), P(5, 10), P(0, 10)].map((p) =>
      P(p.x * PPM, p.y * PPM),
    );
    expect(polygonAreaM2(L, PPM)).toBeCloseTo(75, 9);
    expect(polygonPerimeterMeters(L, PPM)).toBeCloseTo(40, 9);
    expect(isSelfIntersecting(L)).toBe(false);
  });

  it('degenerate inputs', () => {
    expect(polygonAreaPx([])).toBe(0);
    expect(polygonAreaPx([P(0, 0), P(1, 1)])).toBe(0);
    expect(polygonPerimeterMeters([P(0, 0)], 1)).toBe(0);
    expect(polygonPerimeterMeters([P(0, 0), P(3, 4)], 1)).toBeCloseTo(5, 12);
  });
});

describe('centroid', () => {
  it('rectangle centroid is center', () => {
    const c = centroid(rect(10, 4, 1, 100, 200));
    expect(c.x).toBeCloseTo(105, 9);
    expect(c.y).toBeCloseTo(202, 9);
  });

  it('L-shape area centroid (not vertex mean)', () => {
    const L = [P(0, 0), P(10, 0), P(10, 5), P(5, 5), P(5, 10), P(0, 10)];
    // pieces: 10x5 (c=5,2.5,a=50) + 5x5 (c=2.5,7.5,a=25)
    const c = centroid(L);
    expect(c.x).toBeCloseTo((5 * 50 + 2.5 * 25) / 75, 9);
    expect(c.y).toBeCloseTo((2.5 * 50 + 7.5 * 25) / 75, 9);
    const cr = centroid([...L].reverse());
    expect(cr.x).toBeCloseTo(c.x, 9);
    expect(cr.y).toBeCloseTo(c.y, 9);
  });

  it('degenerate falls back to vertex mean', () => {
    expect(centroid([P(0, 0), P(2, 2), P(4, 4)])).toEqual({ x: 2, y: 2 });
    expect(centroid([P(1, 3), P(3, 5)])).toEqual({ x: 2, y: 4 });
    expect(centroid([])).toEqual({ x: 0, y: 0 });
  });
});

describe('pointInPolygon', () => {
  const L = [P(0, 0), P(10, 0), P(10, 5), P(5, 5), P(5, 10), P(0, 10)];
  it('inside / outside, including concave notch', () => {
    expect(pointInPolygon(P(2, 2), L)).toBe(true);
    expect(pointInPolygon(P(2, 8), L)).toBe(true);
    expect(pointInPolygon(P(8, 8), L)).toBe(false); // in the notch
    expect(pointInPolygon(P(-1, 5), L)).toBe(false);
    expect(pointInPolygon(P(11, 1), L)).toBe(false);
  });
  it('fewer than 3 points is never inside', () => {
    expect(pointInPolygon(P(0, 0), [P(0, 0), P(1, 1)])).toBe(false);
  });
});

describe('snapAngle', () => {
  const a = P(10, 10);
  it('snaps near-horizontal to horizontal keeping length', () => {
    const p = P(20, 11);
    const s = snapAngle(a, p);
    expect(s.y).toBe(10);
    expect(distance(a, s)).toBeCloseTo(distance(a, p), 9);
  });
  it('snaps near-vertical to vertical', () => {
    const s = snapAngle(a, P(10.5, -5));
    expect(s.x).toBe(10);
    expect(s.y).toBeLessThan(10);
  });
  it('snaps to 45 degrees', () => {
    const s = snapAngle(a, P(20, 21));
    expect(s.x - a.x).toBeCloseTo(s.y - a.y, 9);
  });
  it('custom step 90 and zero-length', () => {
    const s = snapAngle(a, P(20, 18), 90);
    expect(s.y).toBe(10);
    expect(snapAngle(a, a)).toEqual(a);
  });
});

describe('nearestVertex', () => {
  const pts = [P(0, 0), P(10, 0), P(10, 10)];
  it('returns closest within maxDist, else -1', () => {
    expect(nearestVertex(P(9, 1), pts, 3)).toBe(1);
    expect(nearestVertex(P(5, 5), pts, 3)).toBe(-1);
    expect(nearestVertex(P(5, 0), pts, 10)).toBe(0); // tie -> first
    expect(nearestVertex(P(0, 0), [], 10)).toBe(-1);
  });
});

describe('isSelfIntersecting', () => {
  it('detects bowtie', () => {
    expect(isSelfIntersecting([P(0, 0), P(10, 10), P(10, 0), P(0, 10)])).toBe(true);
  });
  it('simple polygons are valid', () => {
    expect(isSelfIntersecting(rect(5, 5))).toBe(false);
    expect(isSelfIntersecting([...rect(5, 5)].reverse())).toBe(false);
    expect(isSelfIntersecting([P(0, 0), P(1, 0), P(0, 1)])).toBe(false);
  });
  it('detects touching non-adjacent edges', () => {
    // vertex (5,0) touches edge 0 at its interior
    expect(isSelfIntersecting([P(0, 0), P(10, 0), P(10, 10), P(5, 0), P(0, 10)])).toBe(true);
  });
});

describe('formatting', () => {
  it('formatArea', () => {
    expect(formatArea(12.345678)).toBe('12.35 מ״ר');
    expect(formatArea(1234567.891)).toBe('1,234,567.89 מ״ר');
    expect(formatArea(0)).toBe('0.00 מ״ר');
  });
  it('formatLength', () => {
    expect(formatLength(10)).toBe('10.00 מ׳');
    expect(formatLength(1500.5)).toBe('1,500.50 מ׳');
  });
});

describe('parseLengthInput', () => {
  it.each([
    ['10', 10],
    ['10.5', 10.5],
    ['10,5', 10.5],
    [' 7 ', 7],
    ['1050cm', 10.5],
    ['1050 cm', 10.5],
    ['1050 ס״מ', 10.5],
    ['1050 ס"מ', 10.5],
    ['10500mm', 10.5],
    ['10500 מ״מ', 10.5],
    ['10m', 10],
    ['10 M', 10],
    ['10 מ', 10],
    ['10 מ׳', 10],
    ['10 מטר', 10],
    ['.5', 0.5],
  ])('%s -> %d m', (input, expected) => {
    const v = parseLengthInput(input);
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(expected, 9);
  });

  it.each(['', 'abc', '0', '-5', '10 km', '10..5', '1,2,3', 'm10', '10 cm cm'])(
    'rejects %j',
    (input) => {
      expect(parseLengthInput(input)).toBeNull();
    },
  );
});

describe('measurementsToCSV', () => {
  const cal: Calibration = { pixelsPerMeter: 10, p1: P(0, 0), p2: P(100, 0), meters: 10 };
  // legacy objects without `kind` → areas
  const ms: AreaMeasurement[] = [
    { id: 'a', page: 1, label: 'סלון', points: rect(10, 5, 10), color: '#000' },
    { id: 'b', page: 1, label: 'חדר "שינה", הורים', points: rect(2, 3, 10), color: '#000' },
    { id: 'c', page: 2, label: 'מרפסת', points: rect(1, 1, 10), color: '#000' },
  ];
  const csv = measurementsToCSV(ms, { 1: cal });
  const lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');

  it('starts with UTF-8 BOM', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('header row', () => {
    expect(lines[0]).toBe('מס׳,סוג,שם,קטגוריה,עמוד,שטח (מ״ר),היקף (מ׳),אורך (מ׳),כמות,מספר נקודות,שייך ל');
  });

  it('data rows, escaping, uncalibrated page empty area', () => {
    expect(lines[1]).toBe('1,שטח,סלון,,1,50.00,30.00,,,4,');
    expect(lines[2]).toBe('2,שטח,"חדר ""שינה"", הורים",,1,6.00,10.00,,,4,');
    expect(lines[3]).toBe('3,שטח,מרפסת,,2,,,,,4,');
  });

  it('totals rows sum calibrated measurements only', () => {
    expect(lines).toHaveLength(9); // no category subtotals when nothing is categorised
    expect(lines[4]).toBe(',,ברוטו,,,56.00,,,,,');
    expect(lines[5]).toBe(',,ניכויים,,,0.00,,,,,');
    expect(lines[6]).toBe(',,נטו,,,56.00,,,,,');
    expect(lines[7]).toBe(',,סה״כ אורך,,,,,0.00,,,');
    expect(lines[8]).toBe(',,סה״כ כמות,,,,,,0,,');
  });

  it('empty list still has header + totals', () => {
    const out = measurementsToCSV([], {});
    expect(out.startsWith('\uFEFF')).toBe(true);
    expect(out.trimEnd().split('\r\n')).toHaveLength(6);
  });

  it('kinds: deduct rows negative, length rows in length column', () => {
    const mixed: AreaMeasurement[] = [
      { id: 'a', page: 1, kind: 'area', label: 'חזית 1', points: rect(10, 5, 10), color: '#000' },
      { id: 'd', page: 1, kind: 'deduct', label: 'פתח 1', points: rect(2, 1, 10, 20, 20), color: '#000' },
      { id: 'l', page: 1, kind: 'length', label: 'קו 1', points: [P(0, 0), P(30, 40), P(30, 60)], color: '#000' },
      { id: 'o', page: 1, kind: 'deduct', label: 'פתח 2', points: rect(1, 1, 10, 500, 500), color: '#000' },
    ];
    const out = measurementsToCSV(mixed, { 1: cal }).replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    expect(out[1]).toBe('1,שטח,חזית 1,,1,50.00,30.00,,,4,');
    expect(out[2]).toBe('2,ניכוי,פתח 1,,1,-2.00,6.00,,,4,חזית 1');
    expect(out[3]).toBe('3,אורך,קו 1,,1,,,7.00,,3,');
    expect(out[4]).toBe('4,ניכוי,פתח 2,,1,-1.00,4.00,,,4,'); // orphan: listed, not counted
    expect(out[5]).toBe(',,ברוטו,,,50.00,,,,,');
    expect(out[6]).toBe(',,ניכויים,,,-2.00,,,,,');
    expect(out[7]).toBe(',,נטו,,,48.00,,,,,');
    expect(out[8]).toBe(',,סה״כ אורך,,,,,7.00,,,');
    expect(out[9]).toBe(',,סה״כ כמות,,,,,,0,,');
  });

  it('categories + counts: category column, quantity column, per-category subtotal rows', () => {
    const cats = [
      { id: 'clad', name: 'חיפוי', color: '#ff7f0e' },
      { id: 'win', name: 'חלונות', color: '#1f77b4' },
    ];
    const mixed: AreaMeasurement[] = [
      { id: 'a', page: 1, kind: 'area', label: 'חזית 1', points: rect(10, 5, 10), color: '#000', category: 'clad' },
      { id: 'd', page: 1, kind: 'deduct', label: 'פתח 1', points: rect(2, 1, 10, 20, 20), color: '#000', category: 'win' },
      { id: 'n', page: 1, kind: 'count', label: 'W1', points: [P(1, 1), P(2, 2), P(3, 3)], color: '#000', category: 'win' },
      { id: 'u', page: 3, kind: 'count', label: 'D1', points: [P(1, 1), P(2, 2)], color: '#000' }, // uncalibrated page: still counted
      { id: 'l', page: 1, kind: 'length', label: 'מעקה', points: [P(0, 0), P(30, 40)], color: '#000', category: 'ghost' },
    ];
    const out = measurementsToCSV(mixed, { 1: cal }, cats).replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    expect(out[1]).toBe('1,שטח,חזית 1,חיפוי,1,50.00,30.00,,,4,');
    expect(out[2]).toBe('2,ניכוי,פתח 1,חלונות,1,-2.00,6.00,,,4,חזית 1');
    expect(out[3]).toBe('3,ספירה,W1,חלונות,1,,,,3,3,');
    expect(out[4]).toBe('4,ספירה,D1,,3,,,,2,2,');
    expect(out[5]).toBe('5,אורך,מעקה,ghost,1,,,5.00,,2,'); // unknown id → raw key
    // subtotals: order of `cats`, then unknown keys, then uncategorised. The opening is
    // subtracted from the category of the facade it sits in (חיפוי), not from חלונות.
    expect(out[6]).toBe(',,סה״כ חיפוי,חיפוי,,48.00,,0.00,0,,');
    expect(out[7]).toBe(',,סה״כ חלונות,חלונות,,0.00,,0.00,3,,');
    expect(out[8]).toBe(',,סה״כ ghost,ghost,,0.00,,5.00,0,,');
    expect(out[9]).toBe(',,סה״כ ללא קטגוריה,ללא קטגוריה,,0.00,,0.00,2,,');
    expect(out[10]).toBe(',,ברוטו,,,50.00,,,,,');
    expect(out[13]).toBe(',,סה״כ אורך,,,,,5.00,,,');
    expect(out[14]).toBe(',,סה״כ כמות,,,,,,5,,');
    expect(out).toHaveLength(15);
    // TSV built from the same rows
    const tsv = measurementsToTSV(mixed, { 1: cal }, cats).replace(/\r\n$/, '').split('\r\n');
    expect(tsv.map((r) => r.split('\t'))).toEqual(out.map((r) => r.split(',')));
  });
});

describe('measurement kinds', () => {
  const cal: Calibration = { pixelsPerMeter: 10, p1: P(0, 0), p2: P(100, 0), meters: 10 };
  const cals = { 1: cal, 2: cal };
  const M = (id: string, page: number, kind: AreaMeasurement['kind'], points: Point[], label = id): AreaMeasurement => ({
    id,
    page,
    kind,
    label,
    points,
    color: '#000',
  });

  it('kindOf defaults to area', () => {
    expect(kindOf({})).toBe('area');
    expect(kindOf({ kind: 'area' })).toBe('area');
    expect(kindOf({ kind: 'deduct' })).toBe('deduct');
    expect(kindOf({ kind: 'length' })).toBe('length');
    expect(kindOf({ kind: 'bogus' })).toBe('area');
  });

  it('polyline length, midpoint, distance', () => {
    const line = [P(0, 0), P(30, 40), P(30, 60)]; // 50 + 20 = 70 units
    expect(polylineLengthMeters(line, 10)).toBeCloseTo(7, 12);
    expect(polylineLengthMeters([P(0, 0)], 10)).toBe(0);
    expect(polylineMidpoint(line)).toEqual({ x: 21, y: 28 }); // 35 units along first segment
    expect(polylineMidpoint([P(0, 0), P(10, 0)])).toEqual({ x: 5, y: 0 });
    expect(distanceToPolyline(P(30, 50), line)).toBeCloseTo(0, 12);
    expect(distanceToPolyline(P(40, 50), line)).toBeCloseTo(10, 12);
    expect(distanceToPolyline(P(-3, -4), line)).toBeCloseTo(5, 12);
    expect(distanceToPolyline(P(0, 0), [])).toBe(Infinity);
  });

  it('deduct belongs to the area containing its centroid on the same page', () => {
    const ms = [
      M('A', 1, 'area', rect(10, 5, 10)), // 0..100 x 0..50
      M('B', 1, undefined, rect(10, 5, 10, 200, 0)), // legacy area, 200..300
      M('inner', 1, 'area', rect(4, 4, 10, 205, 5)), // nested inside B
      M('d1', 1, 'deduct', rect(2, 1, 10, 10, 10)), // in A
      M('d2', 1, 'deduct', rect(1, 1, 10, 210, 10)), // in B and inner → smallest (inner)
      M('d3', 1, 'deduct', rect(1, 1, 10, 260, 10)), // in B only
      M('d4', 2, 'deduct', rect(1, 1, 10, 10, 10)), // other page: orphan
      M('d5', 1, 'deduct', rect(1, 1, 10, 150, 10)), // between: orphan
    ];
    const a = assignDeductions(ms);
    expect(a.get('d1')).toBe('A');
    expect(a.get('d2')).toBe('inner');
    expect(a.get('d3')).toBe('B');
    expect(a.get('d4')).toBeNull();
    expect(a.get('d5')).toBeNull();
    expect(a.has('A')).toBe(false);

    const net = computeNetAreas(ms, cals);
    expect(net.get('A')).toMatchObject({ grossM2: 50, deductM2: 2, deductIds: ['d1'] });
    expect(net.get('A')!.netM2).toBeCloseTo(48, 12);
    expect(net.get('B')!.netM2).toBeCloseTo(49, 12);
    expect(net.get('inner')!.netM2).toBeCloseTo(15, 12);
    expect(net.has('d1')).toBe(false);
  });

  it('centroid rule works for a concave (L-shaped) area', () => {
    const L = [P(0, 0), P(100, 0), P(100, 50), P(50, 50), P(50, 100), P(0, 100)];
    const ms = [
      M('L', 1, 'area', L),
      M('in', 1, 'deduct', rect(1, 1, 10, 10, 60)),
      M('notch', 1, 'deduct', rect(1, 1, 10, 70, 70)),
    ];
    const a = assignDeductions(ms);
    expect(a.get('in')).toBe('L');
    expect(a.get('notch')).toBeNull();
  });

  it('page and document summaries', () => {
    const ms = [
      M('A', 1, 'area', rect(10, 5, 10)),
      M('d1', 1, 'deduct', rect(2, 1, 10, 10, 10)),
      M('orph', 1, 'deduct', rect(1, 1, 10, 500, 500)),
      M('l1', 1, 'length', [P(0, 0), P(30, 40)]),
      M('B', 2, 'area', rect(3, 3, 10)),
      M('l2', 2, 'length', [P(0, 0), P(0, 25), P(10, 25)]),
      M('U', 3, 'area', rect(3, 3, 10)), // page 3 uncalibrated
    ];
    const p1 = computePageSummary(ms, cals, 1);
    expect(p1.grossM2).toBeCloseTo(50, 12);
    expect(p1.deductM2).toBeCloseTo(2, 12);
    expect(p1.netM2).toBeCloseTo(48, 12);
    expect(p1.lengthM).toBeCloseTo(5, 12);
    expect(p1.orphanDeducts).toBe(1);
    expect(p1.uncalibrated).toBe(0);

    const p3 = computePageSummary(ms, cals, 3);
    expect(p3).toMatchObject({ grossM2: 0, deductM2: 0, netM2: 0, lengthM: 0, uncalibrated: 1 });

    const doc = computeDocumentSummary(ms, cals);
    expect(doc.grossM2).toBeCloseTo(59, 12);
    expect(doc.deductM2).toBeCloseTo(2, 12);
    expect(doc.netM2).toBeCloseTo(57, 12);
    expect(doc.lengthM).toBeCloseTo(8.5, 12);
    expect(doc.uncalibrated).toBe(1);
    expect(doc.orphanDeducts).toBe(1);

    expect(doc.count).toBe(0);
    expect(doc.openingsM2).toBeCloseTo(3, 12); // d1 + orphan

    expect(computeDocumentSummary([], {})).toEqual({
      grossM2: 0,
      deductM2: 0,
      netM2: 0,
      lengthM: 0,
      uncalibrated: 0,
      orphanDeducts: 0,
      count: 0,
      openingsM2: 0,
    });
  });

  it('count measurements: totals without calibration, kind helpers', () => {
    expect(kindOf({ kind: 'count' })).toBe('count');
    expect(minPoints('count')).toBe(1);
    const ms = [
      M('c1', 1, 'count', [P(1, 1), P(5, 5)]),
      M('c2', 3, 'count', [P(1, 1)]), // uncalibrated page
      M('A', 1, 'area', rect(1, 1, 10)),
    ];
    const doc = computeDocumentSummary(ms, cals);
    expect(doc.count).toBe(3);
    expect(doc.uncalibrated).toBe(0); // counts need no scale
    expect(computePageSummary(ms, cals, 3).count).toBe(1);
    expect(nextLabelNumber(ms, 'count')).toBe(3);
    // assignDeductions / net areas ignore counts
    expect(assignDeductions(ms).size).toBe(0);
    expect(computeNetAreas(ms, cals).size).toBe(1);
  });

  it('per-category summaries attribute openings to the facade category', () => {
    const cats = [
      { id: 'clad', name: 'חיפוי', color: '#ff7f0e' },
      { id: 'vit', name: 'ויטרינות', color: '#17becf' },
    ];
    const ms: AreaMeasurement[] = [
      { ...M('A', 1, 'area', rect(10, 5, 10)), category: 'clad' },
      { ...M('B', 2, 'area', rect(3, 3, 10)) }, // uncategorised
      { ...M('d1', 1, 'deduct', rect(2, 1, 10, 10, 10)), category: 'vit' },
      { ...M('d2', 2, 'deduct', rect(1, 1, 10, 5, 5)), category: 'vit' },
      { ...M('orph', 1, 'deduct', rect(1, 1, 10, 500, 500)), category: 'vit' },
      { ...M('n', 1, 'count', [P(0, 0), P(1, 1)]), category: 'vit' },
      { ...M('r', 1, 'length', [P(0, 0), P(0, 25)]), category: 'rail' }, // unknown id
    ];
    const out = computeCategorySummaries(ms, cals, cats);
    expect(out.map((c) => [c.category, c.name])).toEqual([
      ['clad', 'חיפוי'],
      ['vit', 'ויטרינות'],
      ['rail', 'rail'],
      ['', 'ללא קטגוריה'],
    ]);
    const by = Object.fromEntries(out.map((c) => [c.category, c.summary]));
    expect(by.clad.grossM2).toBeCloseTo(50, 12);
    expect(by.clad.deductM2).toBeCloseTo(2, 12);
    expect(by.clad.netM2).toBeCloseTo(48, 12);
    expect(by.vit.grossM2).toBe(0);
    expect(by.vit.deductM2).toBe(0);
    expect(by.vit.openingsM2).toBeCloseTo(4, 12);
    expect(by.vit.orphanDeducts).toBe(1);
    expect(by.vit.count).toBe(2);
    expect(by.rail.lengthM).toBeCloseTo(2.5, 12);
    expect(by[''].netM2).toBeCloseTo(8, 12);
    // category nets add up to the document net
    const doc = computeDocumentSummary(ms, cals);
    expect(out.reduce((a, c) => a + c.summary.netM2, 0)).toBeCloseTo(doc.netM2, 9);
    expect(out.reduce((a, c) => a + c.summary.count, 0)).toBe(doc.count);
  });

  it('category helpers tolerate old / bad data', () => {
    expect(categoryKey({})).toBe('');
    expect(categoryKey({ category: 5 })).toBe('');
    expect(categoryKey({ category: 'win' })).toBe('win');
    expect(categoryName('', DEFAULT_CATEGORIES)).toBe('ללא קטגוריה');
    expect(categoryName('windows', DEFAULT_CATEGORIES)).toBe('חלונות');
    expect(sanitizeCategories(undefined)).toBeNull();
    expect(
      sanitizeCategories([{ id: 'a', name: 'א', color: 'red' }, { id: 'a', name: 'dup' }, null, { name: 'x' }]),
    ).toEqual([{ id: 'a', name: 'א', color: '#64748b' }]);
    expect(new Set(DEFAULT_CATEGORIES.map((c) => c.id)).size).toBe(DEFAULT_CATEGORIES.length);
    expect(DEFAULT_CATEGORIES.map((c) => c.name)).toEqual(expect.arrayContaining(['חלונות', 'ויטרינות', 'חיפוי', 'מעקות']));
  });

  it('nextLabelNumber is per kind', () => {
    const ms = [
      M('a', 1, 'area', [], 'חזית 4'),
      M('b', 1, undefined, [], 'צפונית'),
      M('d', 1, 'deduct', [], 'פתח 1'),
    ];
    expect(nextLabelNumber(ms, 'area')).toBe(5);
    expect(nextLabelNumber(ms, 'deduct')).toBe(2);
    expect(nextLabelNumber(ms, 'length')).toBe(1);
    expect(nextLabelNumber([M('x', 1, 'area', [], 'a'), M('y', 1, 'area', [], 'b')], 'area')).toBe(3);
  });
});

describe('misc', () => {
  it('newId is unique string', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(typeof id).toBe('string');
  });
  it('MEASUREMENT_COLORS has 8 distinct hex colors', () => {
    expect(MEASUREMENT_COLORS).toHaveLength(8);
    expect(new Set(MEASUREMENT_COLORS.map((c) => c.toLowerCase())).size).toBe(8);
    for (const c of MEASUREMENT_COLORS) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe('measurementsToTSV', () => {
  const cal: Calibration = { pixelsPerMeter: 10, p1: P(0, 0), p2: P(100, 0), meters: 10 };
  const ms: AreaMeasurement[] = [
    { id: 'a', page: 1, label: 'סלון', points: rect(10, 5, 10), color: '#000' },
    { id: 'b', page: 1, label: 'חדר "שינה",\tהורים\nקומה\r\nב', points: rect(2, 3, 10), color: '#000' },
  ];
  const tsv = measurementsToTSV(ms, { 1: cal });
  const lines = tsv.replace(/\r\n$/, '').split('\r\n');

  it('no BOM, tab-separated, same rows as CSV builder', () => {
    expect(tsv.charCodeAt(0)).not.toBe(0xfeff);
    const rows = buildMeasurementRows(ms, { 1: cal });
    expect(lines).toHaveLength(rows.length);
    expect(lines[0]).toBe(rows[0].join('\t'));
    rows.forEach((r, i) => expect(lines[i]).toBe(r.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')));
  });

  it('no quoting; tabs/newlines inside cells become spaces', () => {
    const cells = lines[2].split('\t');
    expect(cells).toContain('חדר "שינה", הורים קומה ב');
    expect(lines[1].split('\t')).toContain('סלון');
    expect(lines[1].split('\t')).toContain('50.00');
    for (const l of lines) expect(l.split('\t')).toHaveLength(lines[0].split('\t').length);
  });

  it('CSV and TSV share rows (same cell values)', () => {
    const csvLines = measurementsToCSV(ms.slice(0, 1), { 1: cal }).replace(/^\uFEFF/, '').replace(/\r\n$/, '').split('\r\n');
    const tsvLines = measurementsToTSV(ms.slice(0, 1), { 1: cal }).replace(/\r\n$/, '').split('\r\n');
    expect(tsvLines.map((l) => l.split('\t'))).toEqual(csvLines.map((l) => l.split(',')));
  });
});
