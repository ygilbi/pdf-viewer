/**
 * Pure pixel / data helpers for signature images (no DOM — the dialog feeds them canvas
 * ImageData; export uses the data-URL decoder). Signatures are stored as small trimmed PNG
 * data URLs with a transparent background.
 */
import type { Point } from './types';

/** Upper bound for a stored signature image (data URL characters ≈ bytes). */
export const SIGNATURE_MAX_BYTES = 60_000;
/** Largest stored signature bitmap (px); keeps the PNG small and is plenty for print at ~8 cm. */
export const SIGNATURE_MAX_W = 600;
export const SIGNATURE_MAX_H = 240;

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Makes near-white pixels transparent (scanned / photographed signatures on paper). Pixels whose
 * darkest channel is ≥ `hi` vanish, ≤ `lo` stay opaque, a soft ramp in between keeps the ink's
 * anti-aliased edges. In place; returns the same object.
 */
export function removeWhiteBackground(px: Pixels, lo = 170, hi = 235): Pixels {
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const m = Math.min(d[i], d[i + 1], d[i + 2]);
    if (m >= hi) d[i + 3] = 0;
    else if (m > lo) d[i + 3] = Math.round((d[i + 3] * (hi - m)) / (hi - lo));
  }
  return px;
}

/**
 * Bounding box of the "ink": pixels with alpha > `alphaMin` that are not (near-)white. Null when
 * the image is empty. `pad` px are added on every side (clamped to the image).
 */
export function inkBounds(px: Pixels, alphaMin = 10, pad = 0): { x: number; y: number; width: number; height: number } | null {
  const { data: d, width: w, height: h } = px;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      if (d[i + 3] <= alphaMin) continue;
      if (Math.min(d[i], d[i + 1], d[i + 2]) >= 245) continue; // opaque white paper
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Scale factor (≤ 1) that fits w×h into maxW×maxH. */
export function fitScale(w: number, h: number, maxW = SIGNATURE_MAX_W, maxH = SIGNATURE_MAX_H): number {
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.min(1, maxW / w, maxH / h);
}

/** Approximate decoded size (bytes) of a base64 data URL. */
export function dataUrlByteSize(url: string): number {
  const i = url.indexOf(',');
  const b64 = i >= 0 ? url.slice(i + 1) : url;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Decodes a base64 data URL → { mime, bytes } (null when it is not one). */
export function decodeDataUrl(url: string | undefined): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url ?? '');
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1].toLowerCase(), bytes };
}

/**
 * Smooth stroke through sampled pointer points: quadratic Bézier segments through the midpoints
 * (each sample is a control point) — the classic "smooth signature pad" curve. Returns SVG-style
 * commands the canvas replays: M start, Q c end…, L last.
 */
export function smoothStroke(pts: readonly Point[]): ({ t: 'M' | 'L'; p: Point } | { t: 'Q'; c: Point; p: Point })[] {
  if (!pts.length) return [];
  const out: ({ t: 'M' | 'L'; p: Point } | { t: 'Q'; c: Point; p: Point })[] = [{ t: 'M', p: pts[0] }];
  if (pts.length === 1) {
    out.push({ t: 'L', p: { x: pts[0].x + 0.01, y: pts[0].y } }); // a dot
    return out;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    out.push({ t: 'Q', c: pts[i], p: mid });
  }
  out.push({ t: 'L', p: pts[pts.length - 1] });
  return out;
}
