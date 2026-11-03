/**
 * Vector-geometry snapping, part 1 (worker side, DOM-free, pure).
 *
 * Walks a pdf.js operator list (`page.getOperatorList()`), tracks the current
 * transformation matrix (save / restore / transform / form XObjects / groups),
 * collects the straight segments of every *painted* path (stroke / fill — a
 * path used only as a clip is ignored) in page units (viewport transform at
 * scale 1, rotation applied — the same space measurements live in), and turns
 * them into snap points:
 *   - endpoints (segment ends, curve ends, rectangle corners)
 *   - segment midpoints
 *   - proper intersections between segments (bounded count / time budget)
 *
 * Output is two flat typed arrays (transferable) — see SnapPoints.
 */

export const SNAP_ENDPOINT = 0;
export const SNAP_MIDPOINT = 1;
export const SNAP_INTERSECTION = 2;
export type SnapKind = typeof SNAP_ENDPOINT | typeof SNAP_MIDPOINT | typeof SNAP_INTERSECTION;

/** Flat snap point set for one page (page units). */
export interface SnapPoints {
  /** x0,y0,x1,y1,… (length = 2 * count). */
  xy: Float32Array;
  /** SNAP_* per point. */
  kind: Uint8Array;
  count: number;
  /** Straight segments found on the page (before caps). */
  segments: number;
  /** True when a cap or time budget cut the result short. */
  truncated: boolean;
  /** Extraction time in ms (operator walk + point building, excludes pdf.js parsing). */
  ms: number;
}

/** The pdf.js OPS codes this module needs (pass `OPS` from pdfjs-dist). */
export interface SnapOps {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  moveTo: number;
  lineTo: number;
  curveTo: number;
  curveTo2: number;
  curveTo3: number;
  closePath: number;
  rectangle: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  endPath: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  beginGroup: number;
  endGroup: number;
  beginAnnotation: number;
  endAnnotation: number;
}

export interface SnapLimits {
  /** Max straight segments kept (rest ignored, truncated=true). */
  maxSegments?: number;
  /** Max snap points in the output. Midpoints are dropped first, then intersections. */
  maxPoints?: number;
  /** Max intersections computed. */
  maxIntersections?: number;
  /** Wall-clock budget for the whole extraction (ms). */
  budgetMs?: number;
  /** Segments shorter than this (page units) get no midpoint and no intersections. */
  minFeatureLen?: number;
}

export const DEFAULT_SNAP_LIMITS: Required<SnapLimits> = {
  maxSegments: 400_000,
  maxPoints: 200_000,
  maxIntersections: 60_000,
  budgetMs: 600,
  minFeatureLen: 1,
};

type M = [number, number, number, number, number, number];
const mul = (m: M, n: ArrayLike<number>): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Growable Float64 buffer. */
class Buf {
  a: Float64Array;
  n = 0;
  constructor(cap = 4096) {
    this.a = new Float64Array(cap);
  }
  push4(x1: number, y1: number, x2: number, y2: number) {
    if (this.n + 4 > this.a.length) this.grow();
    const a = this.a;
    a[this.n++] = x1;
    a[this.n++] = y1;
    a[this.n++] = x2;
    a[this.n++] = y2;
  }
  push2(x: number, y: number) {
    if (this.n + 2 > this.a.length) this.grow();
    this.a[this.n++] = x;
    this.a[this.n++] = y;
  }
  private grow() {
    const b = new Float64Array(this.a.length * 2);
    b.set(this.a);
    this.a = b;
  }
}

export interface ExtractedSegments {
  /** x1,y1,x2,y2 per straight segment, page units. */
  segs: Float64Array;
  segCount: number;
  /** Extra endpoints (curve ends) x,y pairs. */
  ends: Float64Array;
  endCount: number;
  truncated: boolean;
}

/**
 * Collect painted straight segments (+ curve endpoints) from an operator list.
 * `viewport` = pdf.js `page.getViewport({scale: 1}).transform`.
 */
export function extractSegments(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  OPS: SnapOps,
  viewport: ArrayLike<number>,
  limits: SnapLimits = {},
  now: () => number = () => performance.now(),
  deadline = Infinity,
): ExtractedSegments {
  const maxSegments = limits.maxSegments ?? DEFAULT_SNAP_LIMITS.maxSegments;
  let ctm: M = [viewport[0], viewport[1], viewport[2], viewport[3], viewport[4], viewport[5]];
  const stack: M[] = [];
  const segs = new Buf();
  const ends = new Buf(256);
  // Segments of the path being built: committed on a paint op, dropped on endPath (clip-only).
  const pend = new Buf(256);
  const pendEnds = new Buf(64);
  let annotDepth = 0;
  let truncated = false;
  let count = 0;

  const commit = () => {
    if (pend.n) {
      const room = (maxSegments - count) * 4;
      const take = Math.min(pend.n, Math.max(0, room));
      for (let i = 0; i < take; i += 4) segs.push4(pend.a[i], pend.a[i + 1], pend.a[i + 2], pend.a[i + 3]);
      count += take / 4;
      if (take < pend.n) truncated = true;
    }
    for (let i = 0; i < pendEnds.n; i += 2) ends.push2(pendEnds.a[i], pendEnds.a[i + 1]);
    pend.n = 0;
    pendEnds.n = 0;
  };

  const n = fnArray.length;
  for (let i = 0; i < n; i++) {
    if ((i & 1023) === 0 && i && now() > deadline) {
      truncated = true;
      break;
    }
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    if (annotDepth > 0) {
      if (fn === OPS.beginAnnotation) annotDepth++;
      else if (fn === OPS.endAnnotation) annotDepth--;
      continue;
    }
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        if (args && args.length >= 6) ctm = mul(ctm, args as number[]);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const mtx = args?.[0] as ArrayLike<number> | null | undefined;
        if (mtx && mtx.length >= 6) ctm = mul(ctm, mtx);
        break;
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.beginGroup: {
        stack.push(ctm);
        const g = args?.[0] as { matrix?: ArrayLike<number> | null } | undefined;
        if (g?.matrix && g.matrix.length >= 6) ctm = mul(ctm, g.matrix);
        break;
      }
      case OPS.endGroup:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.beginAnnotation:
        annotDepth = 1;
        break;
      case OPS.constructPath: {
        if (!args) break;
        const ops = args[0] as ArrayLike<number>;
        const co = args[1] as ArrayLike<number>;
        const [a, b, c, d, e, f] = ctm;
        let j = 0;
        // current point and subpath start, in page units
        let cx = 0;
        let cy = 0;
        let sx = 0;
        let sy = 0;
        let has = false;
        for (let k = 0; k < ops.length; k++) {
          switch (ops[k] | 0) {
            case OPS.rectangle: {
              const x = co[j++];
              const y = co[j++];
              const w = co[j++];
              const h = co[j++];
              const x0 = a * x + c * y + e;
              const y0 = b * x + d * y + f;
              const x1 = a * (x + w) + c * y + e;
              const y1 = b * (x + w) + d * y + f;
              const x2 = a * (x + w) + c * (y + h) + e;
              const y2 = b * (x + w) + d * (y + h) + f;
              const x3 = a * x + c * (y + h) + e;
              const y3 = b * x + d * (y + h) + f;
              if (w === 0 || h === 0) pend.push4(x0, y0, x2, y2);
              else {
                pend.push4(x0, y0, x1, y1);
                pend.push4(x1, y1, x2, y2);
                pend.push4(x2, y2, x3, y3);
                pend.push4(x3, y3, x0, y0);
              }
              cx = sx = x0;
              cy = sy = y0;
              has = true;
              break;
            }
            case OPS.moveTo: {
              const x = co[j++];
              const y = co[j++];
              cx = sx = a * x + c * y + e;
              cy = sy = b * x + d * y + f;
              has = true;
              break;
            }
            case OPS.lineTo: {
              const x = co[j++];
              const y = co[j++];
              const px = a * x + c * y + e;
              const py = b * x + d * y + f;
              if (has && (px !== cx || py !== cy)) pend.push4(cx, cy, px, py);
              cx = px;
              cy = py;
              has = true;
              break;
            }
            case OPS.curveTo:
            case OPS.curveTo2:
            case OPS.curveTo3: {
              const op = ops[k] | 0;
              const step = op === OPS.curveTo ? 6 : 4;
              const x = co[j + step - 2];
              const y = co[j + step - 1];
              j += step;
              if (has) pendEnds.push2(cx, cy);
              cx = a * x + c * y + e;
              cy = b * x + d * y + f;
              pendEnds.push2(cx, cy);
              has = true;
              break;
            }
            case OPS.closePath:
              if (has && (cx !== sx || cy !== sy)) pend.push4(cx, cy, sx, sy);
              cx = sx;
              cy = sy;
              break;
          }
        }
        break;
      }
      case OPS.stroke:
      case OPS.closeStroke:
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        commit();
        break;
      case OPS.endPath:
        pend.n = 0;
        pendEnds.n = 0;
        break;
    }
  }
  return { segs: segs.a, segCount: count, ends: ends.a, endCount: ends.n / 2, truncated };
}

/** Quantised point key (1/64 page unit) for de-duplication. Pages are < 2^21 units. */
const key = (x: number, y: number) => Math.round(x * 64) * 268435456 + Math.round(y * 64);

/**
 * Turn segments into de-duplicated snap points (endpoints > intersections > midpoints).
 */
export function buildSnapPoints(
  ex: ExtractedSegments,
  limits: SnapLimits = {},
  now: () => number = () => performance.now(),
  deadline = Infinity,
): Omit<SnapPoints, 'ms'> {
  const L = { ...DEFAULT_SNAP_LIMITS, ...limits };
  const { segs, segCount: n } = ex;
  let truncated = ex.truncated;
  const seen = new Set<number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const ks: number[] = [];
  const add = (x: number, y: number, k: SnapKind): boolean => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    const kk = key(x, y);
    if (seen.has(kk)) return true;
    if (xs.length >= L.maxPoints) return false;
    seen.add(kk);
    xs.push(x);
    ys.push(y);
    ks.push(k);
    return true;
  };

  // 1. endpoints
  let full = false;
  for (let i = 0; i < n && !full; i++) {
    const o = i * 4;
    if (!add(segs[o], segs[o + 1], SNAP_ENDPOINT) || !add(segs[o + 2], segs[o + 3], SNAP_ENDPOINT)) full = true;
  }
  for (let i = 0; i < ex.endCount && !full; i++) if (!add(ex.ends[i * 2], ex.ends[i * 2 + 1], SNAP_ENDPOINT)) full = true;
  if (full) truncated = true;

  // 2. intersections (grid of long-enough segments; each pair tested in the cell holding the hit)
  const minLen2 = L.minFeatureLen * L.minFeatureLen;
  if (!full && n > 1 && L.maxIntersections > 0) {
    const r = intersections(segs, n, minLen2, L.maxIntersections, now, deadline, (x, y) => {
      if (!add(x, y, SNAP_INTERSECTION)) {
        full = true;
        return false;
      }
      return true;
    });
    if (r.truncated) truncated = true;
  }

  // 3. midpoints
  if (!full) {
    for (let i = 0; i < n; i++) {
      if ((i & 4095) === 0 && now() > deadline) {
        truncated = true;
        break;
      }
      const o = i * 4;
      const dx = segs[o + 2] - segs[o];
      const dy = segs[o + 3] - segs[o + 1];
      if (dx * dx + dy * dy < minLen2 * 4) continue;
      if (!add((segs[o] + segs[o + 2]) / 2, (segs[o + 1] + segs[o + 3]) / 2, SNAP_MIDPOINT)) {
        truncated = true;
        break;
      }
    }
  }

  const count = xs.length;
  const xy = new Float32Array(count * 2);
  const kind = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    xy[i * 2] = xs[i];
    xy[i * 2 + 1] = ys[i];
    kind[i] = ks[i];
  }
  return { xy, kind, count, segments: n, truncated };
}

/** Proper (interior) segment intersections, bounded. `emit` returns false to stop. */
function intersections(
  segs: Float64Array,
  n: number,
  minLen2: number,
  max: number,
  now: () => number,
  deadline: number,
  emit: (x: number, y: number) => boolean,
): { truncated: boolean } {
  // Long-enough segments + bounds
  const idx: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dx = segs[o + 2] - segs[o];
    const dy = segs[o + 3] - segs[o + 1];
    if (dx * dx + dy * dy < minLen2) continue;
    idx.push(i);
    minX = Math.min(minX, segs[o], segs[o + 2]);
    maxX = Math.max(maxX, segs[o], segs[o + 2]);
    minY = Math.min(minY, segs[o + 1], segs[o + 3]);
    maxY = Math.max(maxY, segs[o + 1], segs[o + 3]);
  }
  const m = idx.length;
  if (m < 2) return { truncated: false };
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  // ~2 segments per cell on average, at most 512×512 cells
  const cell = Math.max(1e-3, Math.sqrt((w * h) / Math.max(1, m / 2)));
  const gx = Math.min(512, Math.max(1, Math.ceil(w / cell)));
  const gy = Math.min(512, Math.max(1, Math.ceil(h / cell)));
  const cw = w / gx;
  const ch = h / gy;
  // Bucket segments into every cell their bbox covers (cap per segment so huge lines don't blow up).
  const MAX_CELLS_PER_SEG = 4096;
  const counts = new Int32Array(gx * gy + 1);
  const cellRange = (i: number) => {
    const o = i * 4;
    const x0 = Math.min(gx - 1, Math.max(0, Math.floor((Math.min(segs[o], segs[o + 2]) - minX) / cw)));
    const x1 = Math.min(gx - 1, Math.max(0, Math.floor((Math.max(segs[o], segs[o + 2]) - minX) / cw)));
    const y0 = Math.min(gy - 1, Math.max(0, Math.floor((Math.min(segs[o + 1], segs[o + 3]) - minY) / ch)));
    const y1 = Math.min(gy - 1, Math.max(0, Math.floor((Math.max(segs[o + 1], segs[o + 3]) - minY) / ch)));
    return [x0, x1, y0, y1];
  };
  // Only cells the segment actually passes near (DDA would be exact; bbox ∩ distance test is enough).
  const touches = (i: number, cx: number, cy: number) => {
    const o = i * 4;
    const ax = segs[o];
    const ay = segs[o + 1];
    const dx = segs[o + 2] - ax;
    const dy = segs[o + 3] - ay;
    const mx = minX + (cx + 0.5) * cw;
    const my = minY + (cy + 0.5) * ch;
    const len = Math.hypot(dx, dy) || 1;
    const dist = Math.abs((mx - ax) * dy - (my - ay) * dx) / len;
    return dist <= Math.hypot(cw, ch) / 2;
  };
  const forCells = (i: number, fn: (c: number) => void) => {
    const [x0, x1, y0, y1] = cellRange(i);
    const many = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (many > MAX_CELLS_PER_SEG) return;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (many <= 2 || touches(i, x, y)) fn(y * gx + x);
  };
  for (let k = 0; k < m; k++) forCells(idx[k], (c) => counts[c + 1]++);
  for (let c = 0; c < gx * gy; c++) counts[c + 1] += counts[c];
  const items = new Int32Array(counts[gx * gy]);
  const fill = counts.slice(0, gx * gy);
  for (let k = 0; k < m; k++) forCells(idx[k], (c) => (items[fill[c]++] = idx[k]));

  let found = 0;
  const PAIR_CAP = 96; // a cell denser than this (hatching, text-as-paths) is skipped
  let truncated = false;
  for (let c = 0; c < gx * gy; c++) {
    if ((c & 255) === 0 && now() > deadline) return { truncated: true };
    const s = counts[c];
    const e = counts[c + 1];
    if (e - s < 2) continue;
    if (e - s > PAIR_CAP) {
      truncated = true;
      continue;
    }
    for (let p = s; p < e; p++) {
      const i = items[p] * 4;
      const ax = segs[i];
      const ay = segs[i + 1];
      const rx = segs[i + 2] - ax;
      const ry = segs[i + 3] - ay;
      for (let q = p + 1; q < e; q++) {
        const j = items[q] * 4;
        const bx = segs[j];
        const by = segs[j + 1];
        const sx = segs[j + 2] - bx;
        const sy = segs[j + 3] - by;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9 * (Math.abs(rx) + Math.abs(ry)) * (Math.abs(sx) + Math.abs(sy))) continue; // parallel
        const t = ((bx - ax) * sy - (by - ay) * sx) / den;
        const u = ((bx - ax) * ry - (by - ay) * rx) / den;
        const EPS = 1e-6;
        if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) continue; // touching at an end = endpoint
        const x = ax + t * rx;
        const y = ay + t * ry;
        // count each pair once: only in the cell that contains the hit
        const hx = Math.min(gx - 1, Math.max(0, Math.floor((x - minX) / cw)));
        const hy = Math.min(gy - 1, Math.max(0, Math.floor((y - minY) / ch)));
        if (hy * gx + hx !== c) continue;
        if (!emit(x, y)) return { truncated: true };
        if (++found >= max) return { truncated: true };
      }
    }
  }
  return { truncated };
}

/** Full pipeline: operator list → snap points. */
export function snapPointsFromOperatorList(
  opList: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> },
  OPS: SnapOps,
  viewport: ArrayLike<number>,
  limits: SnapLimits = {},
  now: () => number = () => performance.now(),
): SnapPoints {
  const t0 = now();
  const deadline = t0 + (limits.budgetMs ?? DEFAULT_SNAP_LIMITS.budgetMs);
  const ex = extractSegments(opList.fnArray, opList.argsArray, OPS, viewport, limits, now, deadline);
  const r = buildSnapPoints(ex, limits, now, deadline);
  return { ...r, ms: now() - t0 };
}
