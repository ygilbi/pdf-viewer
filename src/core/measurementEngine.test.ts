import { describe, expect, it } from 'vitest';
import type { AreaMeasurement, Calibration, Point } from './types';
import {
  MEASUREMENT_COLORS,
  centroid,
  computePixelsPerMeter,
  distance,
  formatArea,
  formatLength,
  isSelfIntersecting,
  lengthMeters,
  measurementsToCSV,
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
  const ms: AreaMeasurement[] = [
    { id: 'a', page: 1, label: 'סלון', points: rect(10, 5, 10), color: '#000' },
    { id: 'b', page: 1, label: 'חדר "שינה", הורים', points: rect(2, 3, 10), color: '#000' },
    { id: 'c', page: 2, label: 'מרפסת', points: rect(1, 1, 10), color: '#000' },
  ];
  const csv = measurementsToCSV(ms, { 1: cal });
  const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');

  it('starts with UTF-8 BOM', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('header row', () => {
    expect(lines[0]).toBe('מס׳,שם,עמוד,שטח (מ״ר),היקף (מ׳),מספר נקודות');
  });

  it('data rows, escaping, uncalibrated page empty area', () => {
    expect(lines[1]).toBe('1,סלון,1,50.00,30.00,4');
    expect(lines[2]).toBe('2,"חדר ""שינה"", הורים",1,6.00,10.00,4');
    expect(lines[3]).toBe('3,מרפסת,2,,,4');
  });

  it('total row sums calibrated areas only', () => {
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe(',סה״כ,,56.00,,');
  });

  it('empty list still has header + total', () => {
    const out = measurementsToCSV([], {});
    expect(out.startsWith('﻿')).toBe(true);
    expect(out.trimEnd().split('\r\n')).toHaveLength(2);
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
