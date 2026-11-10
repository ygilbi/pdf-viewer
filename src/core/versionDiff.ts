/**
 * Version compare — pure pixel diff of one page in two versions of a drawing.
 *
 * Both pages are rendered to the same pixel size and converted to grayscale.
 * The old page is first aligned to the new one (a re-exported drawing is often
 * shifted by a few pixels), then a pixel counts as changed only when its value
 * is missing from a 3×3 neighbourhood of the other version — in BOTH directions,
 * so added AND removed lines are found while 1px anti-aliasing jitter is not.
 * Changed pixels are binned into cells, nearby cells are clustered, and every
 * cluster becomes one rectangle (normalized 0..1 page coordinates).
 *
 * No DOM / pdf.js: runs in a worker or in unit tests.
 */

export interface DiffRegion {
  /** Normalized to the page: 0..1 from the left / top. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageDiff {
  regions: DiffRegion[];
  /** Shift applied to the old page (pixels of the diff image). */
  shift: { dx: number; dy: number };
  /** Changed pixels found (before clustering). */
  changedPixels: number;
}

export interface DiffOptions {
  /** Gray-level difference that counts as a change (0..255). */
  threshold?: number;
  /** Cell size in pixels for binning. */
  cell?: number;
  /** Changed pixels a cell needs. */
  minCellPixels?: number;
  /** Cells closer than this (in cells) join one region. */
  gap?: number;
  /** Max |shift| searched when aligning, in pixels. */
  maxShift?: number;
  /** At most this many regions (the gap grows until it fits). */
  maxRegions?: number;
}

const DEFAULTS: Required<DiffOptions> = {
  threshold: 64,
  cell: 8,
  minCellPixels: 2,
  gap: 3,
  maxShift: 24,
  maxRegions: 120,
};

/** RGBA → gray (Rec.601 luma), alpha composited on white. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    const l = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    out[i] = Math.round(l * a + 255 * (1 - a));
  }
  return out;
}

/** Box-downsample a gray image by an integer factor. */
function downsample(g: Uint8Array, w: number, h: number, f: number): { g: Uint8Array; w: number; h: number } {
  const W = Math.max(1, Math.floor(w / f));
  const H = Math.max(1, Math.floor(h / f));
  const out = new Uint8Array(W * H);
  const area = f * f;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) {
        const row = (y * f + yy) * w + x * f;
        for (let xx = 0; xx < f; xx++) s += g[row + xx];
      }
      out[y * W + x] = s / area;
    }
  }
  return { g: out, w: W, h: H };
}

/** Mean absolute difference of `a` shifted by (dx,dy) vs `b`, sampled every `step` px, ignoring all-white pairs. */
function shiftCost(a: Uint8Array, b: Uint8Array, w: number, h: number, dx: number, dy: number, step: number): number {
  let sum = 0;
  let n = 0;
  const x0 = Math.max(0, -dx);
  const x1 = Math.min(w, w - dx);
  const y0 = Math.max(0, -dy);
  const y1 = Math.min(h, h - dy);
  for (let y = y0; y < y1; y += step) {
    const rb = y * w;
    const ra = (y + dy) * w + dx;
    for (let x = x0; x < x1; x += step) {
      const vb = b[rb + x];
      const va = a[ra + x];
      if (vb > 250 && va > 250) continue;
      sum += va > vb ? va - vb : vb - va;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * Integer shift (dx,dy) such that old(x+dx, y+dy) best matches new(x,y).
 * Coarse search on a 4× downsample, then a ±2px refinement at full size.
 */
export function estimateShift(oldG: Uint8Array, newG: Uint8Array, w: number, h: number, maxShift = DEFAULTS.maxShift): { dx: number; dy: number } {
  const f = 4;
  const A = downsample(oldG, w, h, f);
  const B = downsample(newG, w, h, f);
  const r = Math.ceil(maxShift / f);
  let best = { dx: 0, dy: 0 };
  let bestCost = shiftCost(A.g, B.g, A.w, A.h, 0, 0, 1);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (!dx && !dy) continue;
      const c = shiftCost(A.g, B.g, A.w, A.h, dx, dy, 1);
      // Prefer no shift unless another is clearly better (identical pages stay unshifted).
      if (c < bestCost * 0.9) {
        bestCost = c;
        best = { dx, dy };
      }
    }
  }
  const cx = best.dx * f;
  const cy = best.dy * f;
  let fine = { dx: cx, dy: cy };
  let fineCost = shiftCost(oldG, newG, w, h, cx, cy, 1);
  for (let dy = cy - 2; dy <= cy + 2; dy++) {
    for (let dx = cx - 2; dx <= cx + 2; dx++) {
      if ((dx === cx && dy === cy) || Math.abs(dx) > maxShift || Math.abs(dy) > maxShift) continue;
      const c = shiftCost(oldG, newG, w, h, dx, dy, 1);
      if (c < fineCost) {
        fineCost = c;
        fine = { dx, dy };
      }
    }
  }
  return fine;
}

/** Changed-pixel mask: 1 where `p` has no close match in a 3×3 neighbourhood of `q` (q read at +dx,+dy). */
function unmatched(p: Uint8Array, q: Uint8Array, w: number, h: number, dx: number, dy: number, t: number, out: Uint8Array) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = p[y * w + x];
      let found = false;
      for (let yy = -1; yy <= 1 && !found; yy++) {
        const qy = y + dy + yy;
        if (qy < 0 || qy >= h) {
          if (v > 255 - t) found = true; // outside the other page = white
          continue;
        }
        const row = qy * w;
        for (let xx = -1; xx <= 1; xx++) {
          const qx = x + dx + xx;
          const u = qx < 0 || qx >= w ? 255 : q[row + qx];
          if ((u > v ? u - v : v - u) <= t) {
            found = true;
            break;
          }
        }
      }
      if (!found) out[y * w + x] = 1;
    }
  }
}

/** Compares two same-size gray pages; returns the changed regions. */
export function diffPages(oldG: Uint8Array, newG: Uint8Array, w: number, h: number, options: DiffOptions = {}): PageDiff {
  const o = { ...DEFAULTS, ...options };
  const shift = estimateShift(oldG, newG, w, h, o.maxShift);
  const mask = new Uint8Array(w * h);
  // New pixels without a match in the (shifted) old page — added content…
  unmatched(newG, oldG, w, h, shift.dx, shift.dy, o.threshold, mask);
  // …and old pixels without a match in the new page — removed content (mapped into new coordinates).
  const oldMask = new Uint8Array(w * h);
  unmatched(oldG, newG, w, h, -shift.dx, -shift.dy, o.threshold, oldMask);
  for (let y = 0; y < h; y++) {
    const ny = y - shift.dy;
    if (ny < 0 || ny >= h) continue;
    for (let x = 0; x < w; x++) {
      if (!oldMask[y * w + x]) continue;
      const nx = x - shift.dx;
      if (nx >= 0 && nx < w) mask[ny * w + nx] = 1;
    }
  }

  const c = o.cell;
  const cw = Math.ceil(w / c);
  const ch = Math.ceil(h / c);
  const counts = new Uint16Array(cw * ch);
  let changedPixels = 0;
  for (let y = 0; y < h; y++) {
    const cy = ((y / c) | 0) * cw;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        counts[cy + ((x / c) | 0)]++;
        changedPixels++;
      }
    }
  }
  const hot: number[] = [];
  for (let i = 0; i < counts.length; i++) if (counts[i] >= o.minCellPixels) hot.push(i);

  let gap = o.gap;
  let boxes = clusterCells(hot, cw, ch, gap);
  while (boxes.length > o.maxRegions && gap < Math.max(cw, ch)) {
    gap = Math.ceil(gap * 1.6);
    boxes = clusterCells(hot, cw, ch, gap);
  }
  const regions = mergeBoxes(boxes.map((b) => pad(b, 1, cw, ch))).map((b) => ({
    x: (b.x0 * c) / w,
    y: (b.y0 * c) / h,
    width: Math.min(w, (b.x1 + 1) * c) / w - (b.x0 * c) / w,
    height: Math.min(h, (b.y1 + 1) * c) / h - (b.y0 * c) / h,
  }));
  // Reading order: top to bottom, then right to left (Hebrew drawings).
  regions.sort((a, b) => (Math.abs(a.y - b.y) > 0.02 ? a.y - b.y : b.x - a.x));
  return { regions, shift, changedPixels };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Clusters hot cells: cells within `gap` cells (Chebyshev) of each other share a box. */
function clusterCells(hot: number[], cw: number, ch: number, gap: number): Box[] {
  if (!hot.length) return [];
  const label = new Int32Array(cw * ch).fill(-1);
  const isHot = new Uint8Array(cw * ch);
  for (const i of hot) isHot[i] = 1;
  const boxes: Box[] = [];
  const stack: number[] = [];
  for (const start of hot) {
    if (label[start] >= 0) continue;
    const id = boxes.length;
    const box: Box = { x0: cw, y0: ch, x1: -1, y1: -1 };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % cw;
      const y = (i / cw) | 0;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
      const ya = Math.max(0, y - gap);
      const yb = Math.min(ch - 1, y + gap);
      const xa = Math.max(0, x - gap);
      const xb = Math.min(cw - 1, x + gap);
      for (let yy = ya; yy <= yb; yy++) {
        for (let xx = xa; xx <= xb; xx++) {
          const j = yy * cw + xx;
          if (isHot[j] && label[j] < 0) {
            label[j] = id;
            stack.push(j);
          }
        }
      }
    }
    boxes.push(box);
  }
  return boxes;
}

const pad = (b: Box, p: number, cw: number, ch: number): Box => ({
  x0: Math.max(0, b.x0 - p),
  y0: Math.max(0, b.y0 - p),
  x1: Math.min(cw - 1, b.x1 + p),
  y1: Math.min(ch - 1, b.y1 + p),
});

/** Merges overlapping boxes until none overlap. */
export function mergeBoxes(input: Box[]): Box[] {
  const boxes = input.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) {
          boxes[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return boxes;
}

/** Pixel size of the diff image for a page: long side `longSide` px, aspect kept. */
export function diffImageSize(pageW: number, pageH: number, longSide = 1600): { w: number; h: number; scale: number } {
  const scale = longSide / Math.max(pageW, pageH);
  return { w: Math.max(1, Math.round(pageW * scale)), h: Math.max(1, Math.round(pageH * scale)), scale };
}

/** Local page pairs to compare plus the pages that exist in one version only. */
export function pairPages(oldPages: number, newPages: number): { both: number; added: number[]; removed: number[] } {
  const both = Math.min(oldPages, newPages);
  const added: number[] = [];
  const removed: number[] = [];
  for (let p = both + 1; p <= newPages; p++) added.push(p);
  for (let p = both + 1; p <= oldPages; p++) removed.push(p);
  return { both, added, removed };
}
