import { describe, expect, it } from 'vitest';
import type { Point } from './types';
import {
  NOTE_PIN,
  arrowHeadPoints,
  arrowShaftEnd,
  cloudBulge,
  cloudPath,
  estimateTextBounds,
  hitMarkup,
  markupBounds,
  normRect,
  notePinPath,
  polylinePath,
  rectOfPoints,
  rectPath,
  simplifyRDP,
  textLineBaselines,
  translatePoints,
} from './markupGeometry';

const P = (x: number, y: number): Point => ({ x, y });
const ONLY_MLCZ = /^[MLCZ0-9 .\-]+$/;

describe('markupGeometry', () => {
  it('rects', () => {
    expect(normRect(P(10, 20), P(0, 5))).toEqual({ x: 0, y: 5, width: 10, height: 15 });
    expect(rectOfPoints([P(5, 5), P(1, 9)])).toEqual({ x: 1, y: 5, width: 4, height: 4 });
    expect(rectPath({ x: 0, y: 0, width: 10, height: 5 })).toBe('M0 0L10 0L10 5L0 5Z');
  });

  it('cloudPath: closed scallops outside the rect, pdf-lib friendly commands', () => {
    const r = { x: 0, y: 0, width: 80, height: 40 };
    const d = cloudPath(r, 10);
    expect(d).toMatch(ONLY_MLCZ);
    expect(d.startsWith('M0 0')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    // 8 + 4 + 8 + 4 bumps
    expect((d.match(/C/g) ?? []).length).toBe(24);
    // control points lie outside the rect (outward bulge)
    const nums = d.replace(/[MCZ]/g, ' ').trim().split(/\s+/).map(Number);
    let outside = 0;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const [x, y] = [nums[i], nums[i + 1]];
      if (x < 0 || x > 80 || y < 0 || y > 40) outside++;
      expect(x).toBeGreaterThanOrEqual(-10);
      expect(y).toBeLessThanOrEqual(50);
    }
    expect(outside).toBe(48);
    expect(cloudBulge(r, 10)).toBeCloseTo(4.125, 9);
    // degenerate → plain rect
    expect(cloudPath({ x: 0, y: 0, width: 0, height: 5 })).toBe('M0 0L0 0L0 5L0 5Z');
  });

  it('arrow head', () => {
    const [a, tip, b] = arrowHeadPoints(P(0, 0), P(100, 0), 10, 45);
    expect(tip).toEqual({ x: 100, y: 0 });
    expect(a.x).toBeCloseTo(90, 9);
    expect(b.x).toBeCloseTo(90, 9);
    expect(Math.abs(a.y)).toBeCloseTo(10, 9);
    expect(a.y).toBeCloseTo(-b.y, 9);
    expect(arrowShaftEnd(P(0, 0), P(100, 0), 10)).toEqual({ x: 92, y: 0 });
  });

  it('RDP simplification', () => {
    const line = Array.from({ length: 50 }, (_, i) => P(i, i % 2 ? 0.1 : 0));
    expect(simplifyRDP(line, 0.5)).toEqual([P(0, 0), P(49, 0.1)]);
    const corner = [P(0, 0), P(5, 0.05), P(10, 0), P(10, 5), P(10, 10)];
    expect(simplifyRDP(corner, 0.5)).toEqual([P(0, 0), P(10, 0), P(10, 10)]);
    expect(simplifyRDP([P(1, 1)], 1)).toEqual([P(1, 1)]);
  });

  it('text layout (anchor = top-right)', () => {
    const lines = textLineBaselines(P(100, 50), 'א\nבב', 10);
    expect(lines).toEqual([
      { text: 'א', x: 100, y: 59 },
      { text: 'בב', x: 100, y: 71.5 },
    ]);
    const b = estimateTextBounds(P(100, 50), 'אבגד', 10);
    expect(b.x + b.width).toBe(100);
    expect(b.y).toBe(50);
  });

  it('hit testing & bounds', () => {
    const rect = { kind: 'rect', points: [P(0, 0), P(100, 50)] };
    expect(hitMarkup(P(50, 1), rect, 3)).toBe(true);
    expect(hitMarkup(P(50, 25), rect, 3)).toBe(false); // inside, away from outline
    expect(hitMarkup(P(50, 25), { ...rect, kind: 'highlight' }, 3)).toBe(true);
    expect(hitMarkup(P(50, -3), { ...rect, kind: 'cloud' }, 1)).toBe(true);
    expect(hitMarkup(P(20, 21), { kind: 'arrow', points: [P(0, 0), P(40, 40)] }, 2)).toBe(true);
    expect(hitMarkup(P(20, 30), { kind: 'pen', points: [P(0, 0), P(40, 40)] }, 2)).toBe(false);
    const note = { kind: 'note', points: [P(100, 100)] };
    expect(hitMarkup(P(100, 100 - NOTE_PIN.headY * 0.5), note, 1, 0.5)).toBe(true);
    expect(hitMarkup(P(130, 100), note, 1, 0.5)).toBe(false);
    expect(hitMarkup(P(95, 55), { kind: 'text', points: [P(100, 50)], text: 'אב', fontSize: 10 }, 1)).toBe(true);
    expect(markupBounds({ kind: 'pen', points: [P(1, 2), P(5, -3)] })).toEqual({ x: 1, y: -3, width: 4, height: 5 });
    expect(translatePoints([P(1, 1)], 2, -1)).toEqual([P(3, 0)]);
  });

  it('paths', () => {
    expect(polylinePath([P(0, 0), P(1.234, 2)])).toBe('M0 0L1.23 2');
    expect(notePinPath(P(10, 10))).toMatch(ONLY_MLCZ);
  });
});
