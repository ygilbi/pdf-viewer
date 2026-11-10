import { describe, expect, it } from 'vitest';
import { diffPages, estimateShift, fingerprint, matchPages, mergeBoxes, pairPages, toGray } from './versionDiff';

const W = 400;
const H = 300;

/** White page with the given black rectangles (pixel coords). */
function page(rects: [number, number, number, number][], dx = 0, dy = 0): Uint8Array {
  const g = new Uint8Array(W * H).fill(255);
  for (const [x, y, w, h] of rects) {
    for (let yy = y + dy; yy < y + dy + h; yy++) for (let xx = x + dx; xx < x + dx + w; xx++) if (xx >= 0 && yy >= 0 && xx < W && yy < H) g[yy * W + xx] = 0;
  }
  return g;
}

// A "drawing": frame lines + a few details so alignment has something to lock on.
const BASE: [number, number, number, number][] = [
  [10, 10, 380, 2],
  [10, 288, 380, 2],
  [10, 10, 2, 280],
  [388, 10, 2, 280],
  [40, 40, 120, 1],
  [40, 80, 60, 30],
  [250, 200, 90, 1],
];

describe('versionDiff', () => {
  it('identical pages have no changes', () => {
    const r = diffPages(page(BASE), page(BASE), W, H);
    expect(r.regions).toEqual([]);
    expect(r.shift).toEqual({ dx: 0, dy: 0 });
  });

  it('finds an added element and a removed element as two regions', () => {
    const oldG = page([...BASE, [300, 50, 40, 20]]); // removed in new
    const newG = page([...BASE, [60, 220, 50, 3]]); // added in new
    const r = diffPages(oldG, newG, W, H);
    expect(r.regions).toHaveLength(2);
    const [a, b] = r.regions; // sorted top → bottom
    expect(a.x * W).toBeLessThanOrEqual(300);
    expect((a.x + a.width) * W).toBeGreaterThanOrEqual(340);
    expect(a.y * H).toBeLessThanOrEqual(50);
    expect(b.y * H).toBeLessThanOrEqual(220);
    expect((b.y + b.height) * H).toBeGreaterThanOrEqual(223);
  });

  it('a whole-drawing shift is aligned away (no false changes)', () => {
    const oldG = page(BASE);
    const newG = page(BASE, 5, -3);
    expect(estimateShift(oldG, newG, W, H)).toEqual({ dx: -5, dy: 3 });
    expect(diffPages(oldG, newG, W, H).regions).toEqual([]);
  });

  it('1px anti-alias jitter of a thin line is not a change', () => {
    const oldG = page(BASE);
    const newG = page(BASE);
    // Move one short line by 1px only (sub-tolerance)
    for (let x = 250; x < 340; x++) {
      newG[200 * W + x] = 255;
      newG[201 * W + x] = 0;
    }
    expect(diffPages(oldG, newG, W, H).regions).toEqual([]);
  });

  it('a changed dimension text is one region, not one per glyph', () => {
    const oldG = page([...BASE, [200, 120, 3, 8], [206, 120, 3, 8], [212, 120, 3, 8]]);
    const newG = page([...BASE, [200, 120, 3, 8], [206, 122, 6, 6], [216, 120, 3, 8]]);
    expect(diffPages(oldG, newG, W, H).regions).toHaveLength(1);
  });

  it('classifies regions as added / removed / modified', () => {
    const oldG = page([...BASE, [300, 50, 40, 20], [200, 150, 30, 10]]);
    const newG = page([...BASE, [60, 220, 50, 3], [212, 144, 30, 10]]);
    const kinds = diffPages(oldG, newG, W, H).regions.map((r) => r.kind).sort();
    expect(kinds).toEqual(['added', 'modified', 'removed']);
  });

  it('overlay classes: paper / both / added / removed', () => {
    const oldG = page([...BASE, [300, 50, 40, 20]]);
    const newG = page([...BASE, [60, 220, 50, 3]]);
    const o = diffPages(oldG, newG, W, H, { withOverlay: true }).overlay!;
    expect(o[0]).toBe(0);
    expect(o[10 * W + 100]).toBe(1); // frame line in both
    expect(o[221 * W + 80]).toBe(2); // added
    expect(o[60 * W + 320]).toBe(3); // removed
  });

  it('matchPages finds an inserted page instead of shifting every later page', () => {
    const sheets = [0, 1, 2, 3].map((k) => page([...BASE, [30 + k * 80, 120 + k * 30, 60, 40], [k * 90 + 20, 30, 10, 200]]));
    const inserted = page([[50, 50, 300, 200]]);
    const fp = (g: Uint8Array) => fingerprint(g, W, H);
    const r = matchPages(sheets.map(fp), [sheets[0], sheets[1], inserted, sheets[2], sheets[3]].map(fp));
    expect(r.pairs).toEqual([[1, 1], [2, 2], [3, 4], [4, 5]]);
    expect(r.added).toEqual([3]);
    expect(r.removed).toEqual([]);
    const del = matchPages(sheets.map(fp), [sheets[0], sheets[2], sheets[3]].map(fp));
    expect(del.pairs).toEqual([[1, 1], [3, 2], [4, 3]]);
    expect(del.removed).toEqual([2]);
  });

  it('toGray composites alpha on white', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
    expect([...toGray(rgba, 3, 1)]).toEqual([0, 255, 255]);
  });

  it('mergeBoxes joins overlapping boxes', () => {
    expect(
      mergeBoxes([
        { x0: 0, y0: 0, x1: 4, y1: 4 },
        { x0: 3, y0: 3, x1: 8, y1: 8 },
        { x0: 20, y0: 20, x1: 21, y1: 21 },
      ]),
    ).toEqual([
      { x0: 0, y0: 0, x1: 8, y1: 8 },
      { x0: 20, y0: 20, x1: 21, y1: 21 },
    ]);
  });

  it('pairPages lists added / removed pages', () => {
    expect(pairPages(3, 5)).toEqual({ both: 3, added: [4, 5], removed: [] });
    expect(pairPages(4, 2)).toEqual({ both: 2, added: [], removed: [3, 4] });
  });
});
