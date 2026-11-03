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

/**
 * De-duplicating point set: open-addressing hash on coordinates quantised to
 * 1/64 page unit, storing into growable typed arrays (no per-point objects).
 */
class PointSet {
  xy: Float32Array;
  kind: Uint8Array;
  count = 0;
  private qx: Int32Array;
  private qy: Int32Array;
  private table: Int32Array;
  private mask: number;
  constructor(
    private readonly max: number,
    expected: number,
  ) {
    const cap = Math.max(64, Math.min(max, expected));
    this.xy = new Float32Array(cap * 2);
    this.kind = new Uint8Array(cap);
    this.qx = new Int32Array(cap);
    this.qy = new Int32Array(cap);
    let size = 1024;
    while (size < Math.min(max, expected) * 2) size <<= 1;
    this.table = new Int32Array(size).fill(-1);
    this.mask = size - 1;
  }
  /** false when full. */
  add(x: number, y: number, k: number): boolean {
    if (!(x === x && y === y) || !Number.isFinite(x + y)) return true;
    const ix = Math.round(x * 64) | 0;
    const iy = Math.round(y * 64) | 0;
    let h = (Math.imul(ix, 0x9e3779b1) ^ Math.imul(iy, 0x85ebca77)) & this.mask;
    const t = this.table;
    for (;;) {
      const i = t[h];
      if (i < 0) break;
      if (this.qx[i] === ix && this.qy[i] === iy) return true;
      h = (h + 1) & this.mask;
    }
    if (this.count >= this.max) return false;
    const n = this.count++;
    if (n >= this.kind.length) this.grow();
    this.qx[n] = ix;
    this.qy[n] = iy;
    this.xy[n * 2] = x;
    this.xy[n * 2 + 1] = y;
    this.kind[n] = k;
    t[h] = n;
    if (this.count * 2 > t.length) this.rehash();
    return true;
  }
  private grow() {
    const cap = Math.min(this.max, this.kind.length * 2);
    const xy = new Float32Array(cap * 2);
    xy.set(this.xy);
    const kind = new Uint8Array(cap);
    kind.set(this.kind);
    const qx = new Int32Array(cap);
    qx.set(this.qx);
    const qy = new Int32Array(cap);
    qy.set(this.qy);
    this.xy = xy;
    this.kind = kind;
    this.qx = qx;
    this.qy = qy;
  }
  private rehash() {
    const size = this.table.length * 2;
    const t = new Int32Array(size).fill(-1);
    const mask = size - 1;
    for (let i = 0; i < this.count; i++) {
      let h = (Math.imul(this.qx[i], 0x9e3779b1) ^ Math.imul(this.qy[i], 0x85ebca77)) & mask;
      while (t[h] >= 0) h = (h + 1) & mask;
      t[h] = i;
    }
    this.table = t;
    this.mask = mask;
  }
}

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
  const set = new PointSet(L.maxPoints, n * 3 + ex.endCount);
  let full = false;

  // 1. endpoints
  for (let i = 0; i < n && !full; i++) {
    const o = i * 4;
    if (!set.add(segs[o], segs[o + 1], SNAP_ENDPOINT) || !set.add(segs[o + 2], segs[o + 3], SNAP_ENDPOINT)) full = true;
  }
  for (let i = 0; i < ex.endCount && !full; i++) if (!set.add(ex.ends[i * 2], ex.ends[i * 2 + 1], SNAP_ENDPOINT)) full = true;

  // 2. intersections
  const minLen2 = L.minFeatureLen * L.minFeatureLen;
  if (!full && n > 1 && L.maxIntersections > 0) {
    const r = intersections(segs, n, minLen2, L.maxIntersections, now, deadline, (x, y) => {
      if (set.add(x, y, SNAP_INTERSECTION)) return true;
      full = true;
      return false;
    });
    if (r.truncated) truncated = true;
  }

  // 3. midpoints
  for (let i = 0; i < n && !full; i++) {
    if ((i & 4095) === 0 && i && now() > deadline) {
      truncated = true;
      break;
    }
    const o = i * 4;
    const dx = segs[o + 2] - segs[o];
    const dy = segs[o + 3] - segs[o + 1];
    if (dx * dx + dy * dy < minLen2 * 4) continue;
    if (!set.add((segs[o] + segs[o + 2]) / 2, (segs[o + 1] + segs[o + 3]) / 2, SNAP_MIDPOINT)) full = true;
  }
  if (full) truncated = true;

  const count = set.count;
  return { xy: set.xy.slice(0, count * 2), kind: set.kind.slice(0, count), count, segments: n, truncated };
}

/** Proper (interior) segment intersections via a uniform grid, bounded. `emit` returns false to stop. */
function intersections(
  segs: Float64Array,
  n: number,
  minLen2: number,
  max: number,
  now: () => number,
  deadline: number,
  emit: (x: number, y: number) => boolean,
): { truncated: boolean } {
  const idx = new Int32Array(n);
  let m = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dx = segs[o + 2] - segs[o];
    const dy = segs[o + 3] - segs[o + 1];
    if (dx * dx + dy * dy < minLen2) continue;
    idx[m++] = i;
    const ax = segs[o];
    const bx = segs[o + 2];
    const ay = segs[o + 1];
    const by = segs[o + 3];
    if (ax < minX) minX = ax;
    if (bx < minX) minX = bx;
    if (ax > maxX) maxX = ax;
    if (bx > maxX) maxX = bx;
    if (ay < minY) minY = ay;
    if (by < minY) minY = by;
    if (ay > maxY) maxY = ay;
    if (by > maxY) maxY = by;
  }
  if (m < 2) return { truncated: false };
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  // ~2 segments per cell on average, at most 1024 cells per side
  const cell = Math.max(w / 1024, h / 1024, Math.sqrt((w * h) / Math.max(1, m / 2)));
  const gx = Math.max(1, Math.min(1024, Math.ceil(w / cell)));
  const gy = Math.max(1, Math.min(1024, Math.ceil(h / cell)));
  const cw = w / gx;
  const ch = h / gy;
  const half = Math.hypot(cw, ch) / 2;
  const cells = gx * gy;
  const MAX_CELLS_PER_SEG = 4096;
  const range = new Int32Array(m * 4);
  for (let k = 0; k < m; k++) {
    const o = idx[k] * 4;
    const ax = segs[o];
    const ay = segs[o + 1];
    const bx = segs[o + 2];
    const by = segs[o + 3];
    range[k * 4] = Math.min(gx - 1, Math.floor(((ax < bx ? ax : bx) - minX) / cw));
    range[k * 4 + 1] = Math.min(gx - 1, Math.floor(((ax > bx ? ax : bx) - minX) / cw));
    range[k * 4 + 2] = Math.min(gy - 1, Math.floor(((ay < by ? ay : by) - minY) / ch));
    range[k * 4 + 3] = Math.min(gy - 1, Math.floor(((ay > by ? ay : by) - minY) / ch));
  }
  // Two passes (count, fill) over the cells each segment actually passes near.
  const start = new Int32Array(cells + 1);
  let items = new Int32Array(0);
  for (let pass = 0; pass < 2; pass++) {
    const fill = pass ? start.slice(0, cells) : null;
    for (let k = 0; k < m; k++) {
      const x0 = range[k * 4];
      const x1 = range[k * 4 + 1];
      const y0 = range[k * 4 + 2];
      const y1 = range[k * 4 + 3];
      const many = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (many > MAX_CELLS_PER_SEG) continue;
      const seg = idx[k];
      if (x0 === x1 || y0 === y1) {
        // axis-aligned-ish strip: every cell of the bbox is touched
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const c = y * gx + x;
            if (fill) items[fill[c]++] = seg;
            else start[c + 1]++;
          }
        continue;
      }
      const o = seg * 4;
      const ax = segs[o];
      const ay = segs[o + 1];
      const dx = segs[o + 2] - ax;
      const dy = segs[o + 3] - ay;
      const inv = 1 / Math.hypot(dx, dy);
      const nx = -dy * inv;
      const ny = dx * inv;
      const c0 = nx * ax + ny * ay;
      for (let y = y0; y <= y1; y++) {
        const my = minY + (y + 0.5) * ch;
        for (let x = x0; x <= x1; x++) {
          const mx = minX + (x + 0.5) * cw;
          if (Math.abs(nx * mx + ny * my - c0) > half) continue;
          const c = y * gx + x;
          if (fill) items[fill[c]++] = seg;
          else start[c + 1]++;
        }
      }
    }
    if (!pass) {
      for (let c = 0; c < cells; c++) start[c + 1] += start[c];
      items = new Int32Array(start[cells]);
    }
  }

  let found = 0;
  const PAIR_CAP = 96; // a cell denser than this (hatching, text-as-paths) is skipped
  let truncated = false;
  const EPS = 1e-6;
  for (let c = 0; c < cells; c++) {
    const s = start[c];
    const e = start[c + 1];
    if (e - s < 2) continue;
    if ((c & 1023) === 0 && now() > deadline) return { truncated: true };
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
      const rl = Math.abs(rx) + Math.abs(ry);
      for (let q = p + 1; q < e; q++) {
        const j = items[q] * 4;
        const bx = segs[j];
        const by = segs[j + 1];
        const sx = segs[j + 2] - bx;
        const sy = segs[j + 3] - by;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9 * rl * (Math.abs(sx) + Math.abs(sy))) continue; // parallel
        const t = ((bx - ax) * sy - (by - ay) * sx) / den;
        if (t <= EPS || t >= 1 - EPS) continue;
        const u = ((bx - ax) * ry - (by - ay) * rx) / den;
        if (u <= EPS || u >= 1 - EPS) continue; // touching at an end = endpoint
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
