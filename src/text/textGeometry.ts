/**
 * Pure text-geometry helpers (no pdf.js import — safe in tests and in both the
 * worker and the main-thread fallback).
 *
 * pdf.js `getTextContent()` items carry a text matrix (`transform`) in PDF user
 * space plus `width` (advance along the baseline, user units) and `height`
 * (≈ font size, user units). We map them into PAGE UNITS = the rotated
 * viewport at scale 1 (`page.getViewport({ scale: 1 }).transform`), the same
 * space all measurements live in.
 */
import type { Rect, TextItem } from '../core/types';

/** 2D affine matrix [a, b, c, d, e, f] (pdf.js convention). */
export type Matrix = readonly [number, number, number, number, number, number] | readonly number[];

/** Fraction of the font height above the baseline (same default as pdf.js' text layer). */
export const ASCENT = 0.8;

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * The viewport transform pdf.js' PageViewport builds for `scale`, `rotation`
 * (0/90/180/270) and a page `view` box [x0, y0, x1, y1]. Used by tests to
 * reproduce real viewports without pdf.js.
 */
export function viewportTransform(view: readonly number[], rotation = 0, scale = 1): number[] {
  const [x0, y0, x1, y1] = view;
  const cx = (x1 + x0) / 2;
  const cy = (y1 + y0) / 2;
  let r = rotation % 360;
  if (r < 0) r += 360;
  let a = 1,
    b = 0,
    c = 0,
    d = -1;
  if (r === 90) [a, b, c, d] = [0, 1, 1, 0];
  else if (r === 180) [a, b, c, d] = [-1, 0, 0, 1];
  else if (r === 270) [a, b, c, d] = [0, -1, -1, 0];
  let ox: number, oy: number;
  if (a === 0) {
    ox = Math.abs(cy - y0) * scale;
    oy = Math.abs(cx - x0) * scale;
  } else {
    ox = Math.abs(cx - x0) * scale;
    oy = Math.abs(cy - y0) * scale;
  }
  return [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy];
}

/**
 * Converts one pdf.js text item to a TextItem in page units.
 * `vt` = viewport.transform (scale 1, rotation applied).
 * Returns null for empty / whitespace-only / degenerate items.
 */
export function toTextItem(
  vt: Matrix,
  item: { str: string; transform: Matrix; width: number; height: number; dir?: string },
): TextItem | null {
  const str = item.str;
  if (!str || !str.trim()) return null;
  const t = item.transform;
  // Unit vectors of the text's baseline / "up" directions in user space.
  const ul = Math.hypot(t[0], t[1]);
  const vl = Math.hypot(t[2], t[3]);
  if (!(ul > 0) && !(vl > 0)) return null;
  const bx = ul > 0 ? t[0] / ul : vl > 0 ? t[3] / vl : 1;
  const by = ul > 0 ? t[1] / ul : vl > 0 ? -t[2] / vl : 0;
  const upx = vl > 0 ? t[2] / vl : -by;
  const upy = vl > 0 ? t[3] / vl : bx;
  const w = Number.isFinite(item.width) && item.width > 0 ? item.width : 0;
  const h = Number.isFinite(item.height) && item.height > 0 ? item.height : vl || ul;
  if (!(h > 0) && !(w > 0)) return null;
  // Quad in user space: baseline origin shifted down by the descent.
  const desc = 1 - ASCENT;
  const oxU = t[4] - upx * h * desc;
  const oyU = t[5] - upy * h * desc;
  const [ox, oy] = applyMatrix(vt, oxU, oyU);
  // Linear part of the viewport transform for direction vectors.
  const lin = (x: number, y: number): [number, number] => [vt[0] * x + vt[2] * y, vt[1] * x + vt[3] * y];
  const [ux, uy] = lin(bx * w, by * w);
  const [vx, vy] = lin(upx * h, upy * h);
  const q: TextItem['q'] = [ox, oy, ux, uy, vx, vy];
  const rtl = item.dir ? item.dir === 'rtl' : startsRtl(str);
  return rtl ? { str, rect: quadRect(q, 0, 1), q, rtl } : { str, rect: quadRect(q, 0, 1), q };
}

/** First strong character is Hebrew / Arabic (fallback when pdf.js gives no `dir`). */
export function startsRtl(s: string): boolean {
  const m = /[A-Za-z\u00C0-\u024F\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.exec(s);
  return !!m && /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(m[0]);
}

/** Axis-aligned bounds of the part [t0, t1] (fractions of the baseline) of a text quad. */
export function quadRect(q: TextItem['q'], t0: number, t1: number): Rect {
  const [ox, oy, ux, uy, vx, vy] = q;
  const ax = ox + ux * t0;
  const ay = oy + uy * t0;
  const dx = ux * (t1 - t0);
  const dy = uy * (t1 - t0);
  const xs = [ax, ax + dx, ax + vx, ax + dx + vx];
  const ys = [ay, ay + dy, ay + vy, ay + dy + vy];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Bounds of characters [start, end) of an item (proportional along the baseline). */
export function substringRect(item: TextItem, start: number, end: number): Rect {
  const n = item.str.length || 1;
  const a = Math.max(0, start) / n;
  const b = Math.min(n, end) / n;
  // RTL: logical character 0 is drawn at the END of the baseline (right side of a Hebrew line).
  return item.rtl ? quadRect(item.q, 1 - b, 1 - a) : quadRect(item.q, a, b);
}

export function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Converts a whole pdf.js TextContent `items` array (TextMarkedContent entries are skipped). */
export function toTextItems(vt: Matrix, items: readonly unknown[]): TextItem[] {
  const out: TextItem[] = [];
  for (const it of items) {
    const o = it as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown; dir?: unknown };
    if (typeof o.str !== 'string' || !Array.isArray(o.transform)) continue;
    const t = toTextItem(vt, {
      str: o.str,
      transform: o.transform as number[],
      width: Number(o.width) || 0,
      height: Number(o.height) || 0,
      ...(typeof o.dir === 'string' ? { dir: o.dir } : {}),
    });
    if (t) out.push(t);
  }
  return out;
}
