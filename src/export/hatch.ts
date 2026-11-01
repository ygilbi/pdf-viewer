import type { Point } from '../core/types';

/**
 * 45° hatch lines clipped to a polygon (even-odd), as segments — lets the
 * export draw a hatch without PDF clipping paths. `spacing` = distance
 * between hatch lines (page units).
 */
export function hatchSegments(poly: Point[], spacing: number): [Point, Point][] {
  const n = poly.length;
  if (n < 3 || !(spacing > 0)) return [];
  const S = Math.SQRT1_2;
  // Rotate by −45°: u along the hatch direction (x+y), w across it (x−y).
  const pts = poly.map((p) => ({ u: (p.x + p.y) * S, w: (p.x - p.y) * S }));
  let wMin = Infinity, wMax = -Infinity;
  for (const p of pts) {
    wMin = Math.min(wMin, p.w);
    wMax = Math.max(wMax, p.w);
  }
  const out: [Point, Point][] = [];
  const back = (u: number, w: number): Point => ({ x: (u + w) * S, y: (u - w) * S });
  const start = Math.ceil(wMin / spacing) * spacing;
  for (let w = start; w <= wMax; w += spacing) {
    const us: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      // half-open rule so a vertex exactly on the line is counted once
      if (a.w > w !== b.w > w) us.push(a.u + ((w - a.w) / (b.w - a.w)) * (b.u - a.u));
    }
    us.sort((p, q) => p - q);
    for (let k = 0; k + 1 < us.length; k += 2) {
      if (us[k + 1] - us[k] > 1e-9) out.push([back(us[k], w), back(us[k + 1], w)]);
    }
  }
  return out;
}
