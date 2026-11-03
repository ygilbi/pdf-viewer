/**
 * Vector-geometry snapping, part 2 (main thread): a uniform grid over a page's
 * snap points (CSR layout: cellStart + items) answering "nearest snap point
 * within r" in O(points in the few cells around the cursor).
 */
import type { Point } from './types';
import { SNAP_ENDPOINT, SNAP_INTERSECTION, SNAP_MIDPOINT, type SnapKind } from './vectorSnap';

export { SNAP_ENDPOINT, SNAP_INTERSECTION, SNAP_MIDPOINT, type SnapKind };

export interface SnapHit {
  x: number;
  y: number;
  kind: SnapKind;
  /** Distance from the query point (page units). */
  dist: number;
}

/** Midpoints only win when clearly closer than an endpoint / intersection. */
const MID_PENALTY = 1.35;
/** Upper bound of cells visited per query (very low zoom → huge radius). */
const MAX_CELLS = 4096;

export class SnapIndex {
  readonly count: number;
  private readonly xy: Float32Array;
  private readonly kind: Uint8Array;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cell: number;
  private readonly gx: number;
  private readonly gy: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;

  constructor(xy: Float32Array, kind: Uint8Array, count = kind.length) {
    this.xy = xy;
    this.kind = kind;
    this.count = count;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = xy[i * 2];
      const y = xy[i * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!count) minX = minY = maxX = maxY = 0;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    // ~4 points per cell, cells ≥ 1 unit, ≤ 1024 per side
    let cell = Math.max(1, Math.sqrt((w * h) / Math.max(1, count / 4)));
    cell = Math.max(cell, w / 1024, h / 1024);
    this.minX = minX;
    this.minY = minY;
    this.cell = cell;
    this.gx = Math.max(1, Math.ceil(w / cell) + 1);
    this.gy = Math.max(1, Math.ceil(h / cell) + 1);
    const cells = this.gx * this.gy;
    const start = new Int32Array(cells + 1);
    const cellOf = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const c = this.cellIndex(xy[i * 2], xy[i * 2 + 1]);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const fill = start.slice(0, cells);
    const items = new Int32Array(count);
    for (let i = 0; i < count; i++) items[fill[cellOf[i]]++] = i;
    this.start = start;
    this.items = items;
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.gx - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const cy = Math.min(this.gy - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
    return cy * this.gx + cx;
  }

  /** Best snap point within `r` of p (midpoints slightly penalised), or null. */
  nearest(p: Point, r: number): SnapHit | null {
    if (!this.count || !(r > 0)) return null;
    const { xy, kind, cell, minX, minY, gx, gy, start, items } = this;
    let x0 = Math.floor((p.x - r - minX) / cell);
    let x1 = Math.floor((p.x + r - minX) / cell);
    let y0 = Math.floor((p.y - r - minY) / cell);
    let y1 = Math.floor((p.y + r - minY) / cell);
    if (x1 < 0 || y1 < 0 || x0 >= gx || y0 >= gy) return null;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(gx - 1, x1);
    y1 = Math.min(gy - 1, y1);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) {
      // Shrink the window around the cursor (the radius is huge relative to the density).
      const half = Math.floor(Math.sqrt(MAX_CELLS) / 2);
      const cx = Math.floor((p.x - minX) / cell);
      const cy = Math.floor((p.y - minY) / cell);
      x0 = Math.max(x0, cx - half);
      x1 = Math.min(x1, cx + half);
      y0 = Math.max(y0, cy - half);
      y1 = Math.min(y1, cy + half);
    }
    const r2 = r * r;
    let best = -1;
    let bestScore = Infinity;
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * gx;
      for (let cx = x0; cx <= x1; cx++) {
        const c = row + cx;
        for (let k = start[c], e = start[c + 1]; k < e; k++) {
          const i = items[k];
          const dx = xy[i * 2] - p.x;
          const dy = xy[i * 2 + 1] - p.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const score = kind[i] === SNAP_MIDPOINT ? d2 * MID_PENALTY * MID_PENALTY : d2;
          if (score < bestScore || (score === bestScore && kind[i] < kind[best])) {
            bestScore = score;
            best = i;
          }
        }
      }
    }
    if (best < 0) return null;
    const x = xy[best * 2];
    const y = xy[best * 2 + 1];
    return { x, y, kind: kind[best] as SnapKind, dist: Math.hypot(x - p.x, y - p.y) };
  }
}

/** Nearest of a small extra point list (e.g. existing measurement vertices), or null. */
export function nearestExtra(p: Point, pts: readonly Point[], r: number): SnapHit | null {
  let best: SnapHit | null = null;
  for (const q of pts) {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= r && (!best || d < best.dist)) best = { x: q.x, y: q.y, kind: SNAP_ENDPOINT, dist: d };
  }
  return best;
}

/** Combine candidates: endpoints/intersections beat midpoints unless the midpoint is clearly closer. */
export function pickSnap(a: SnapHit | null, b: SnapHit | null): SnapHit | null {
  if (!a) return b;
  if (!b) return a;
  const sa = a.kind === SNAP_MIDPOINT ? a.dist * MID_PENALTY : a.dist;
  const sb = b.kind === SNAP_MIDPOINT ? b.dist * MID_PENALTY : b.dist;
  return sb < sa ? b : a;
}

/** Orthogonal projection of q onto the ray from `anchor` through `dir` (dir need not be unit). */
export function projectOnRay(anchor: Point, dir: Point, q: Point): Point {
  const dx = dir.x - anchor.x;
  const dy = dir.y - anchor.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return { x: q.x, y: q.y };
  const t = ((q.x - anchor.x) * dx + (q.y - anchor.y) * dy) / l2;
  let x = anchor.x + t * dx;
  let y = anchor.y + t * dy;
  if (Math.abs(dx) < 1e-9 * Math.sqrt(l2)) x = anchor.x;
  if (Math.abs(dy) < 1e-9 * Math.sqrt(l2)) y = anchor.y;
  return { x, y };
}
