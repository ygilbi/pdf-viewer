/**
 * Pure geometry for markup / annotation kinds (see `MarkupKind` in types.ts).
 *
 * Everything is in PDF page units (top-left origin, y down — the same space
 * as `AreaMeasurement.points`). SVG path strings use only M / L / C / Z so
 * they can be fed straight to pdf-lib's `page.drawSvgPath(d, { x: 0, y:
 * pageHeight })` (pdf-lib flips y for SVG paths) as well as to the viewer's
 * <path d>. No DOM, no React — shared by the viewer overlay and PDF export.
 */
import type { Point, Rect } from './types';

/** Default stroke width (screen px at 100% zoom; export: PDF points). */
export const DEFAULT_STROKE_WIDTH = 2;
/** Stroke widths offered by the style picker. */
export const STROKE_WIDTHS = [1, 2, 4, 6] as const;
/** Fill opacity of a highlight rectangle. */
export const HIGHLIGHT_OPACITY = 0.35;
/** Default highlight colour (marker yellow). */
export const HIGHLIGHT_COLOR = '#facc15';
/** Default colour of new markup when no category is active. */
export const MARKUP_COLOR = '#dc2626';
/** Line height of 'text' markup, in multiples of the font size. */
export const TEXT_LINE_HEIGHT = 1.25;
/** Arrow head length = max(ARROW_HEAD_MIN, strokeWidth * ARROW_HEAD_FACTOR) (same units as the stroke). */
export const ARROW_HEAD_FACTOR = 4;
export const ARROW_HEAD_MIN = 9;

/**
 * Note pin (speech-pin) geometry in "pin units" (= screen px in the viewer,
 * PDF points in export). The tip sits on the anchor point; the round head is
 * centred `PIN_HEAD_Y` above it.
 */
export const NOTE_PIN = { headY: 17, radius: 10 } as const;

export function normRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Rect from the first two points of a rect / cloud / highlight markup. */
export function rectOfPoints(points: Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  return normRect(points[0], points[points.length > 1 ? 1 : 0]);
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

export function rectPath(r: Rect): string {
  const { x, y, width: w, height: h } = r;
  return `M${f(x)} ${f(y)}L${f(x + w)} ${f(y)}L${f(x + w)} ${f(y + h)}L${f(x)} ${f(y + h)}Z`;
}

/** Open polyline as an SVG path (M … L …). */
export function polylinePath(points: Point[]): string {
  if (points.length === 0) return '';
  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length; i++) d += `L${f(points[i].x)} ${f(points[i].y)}`;
  if (points.length === 1) d += `L${f(points[0].x + 0.01)} ${f(points[0].y)}`;
  return d;
}

/** Box shapes drawn inside the two-corner rectangle (besides 'rect' itself). */
export type BoxShape = 'ellipse' | 'triangle' | 'diamond';
export const isBoxShape = (k: string | undefined): k is BoxShape => k === 'ellipse' || k === 'triangle' || k === 'diamond';

/** Closed outline of a box shape (ellipse sampled with `n` points) — for hit testing. */
export function shapeOutline(kind: BoxShape, r: Rect, n = 48): Point[] {
  const { x, y, width: w, height: h } = r;
  if (kind === 'triangle') return [{ x: x + w / 2, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  if (kind === 'diamond') return [{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }];
  const cx = x + w / 2, cy = y + h / 2;
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: cx + (w / 2) * Math.cos(t), y: cy + (h / 2) * Math.sin(t) };
  });
}

/** SVG path (M / L / C / Z only) of a box shape; the ellipse as four cubic arcs. */
export function shapePath(kind: BoxShape, r: Rect): string {
  if (kind !== 'ellipse') {
    const o = shapeOutline(kind, r);
    return o.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join('') + 'Z';
  }
  const { x, y, width: w, height: h } = r;
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
  const kx = 0.5523 * rx, ky = 0.5523 * ry;
  return (
    `M${f(cx + rx)} ${f(cy)}` +
    `C${f(cx + rx)} ${f(cy + ky)} ${f(cx + kx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}` +
    `C${f(cx - kx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ky)} ${f(cx - rx)} ${f(cy)}` +
    `C${f(cx - rx)} ${f(cy - ky)} ${f(cx - kx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}` +
    `C${f(cx + kx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ky)} ${f(cx + rx)} ${f(cy)}Z`
  );
}

/** Default scallop chord length for a revision cloud around `r` (page units). */
export function cloudArcSize(r: Rect): number {
  return Math.max(6, Math.min(30, Math.max(r.width, r.height) / 8));
}

/**
 * Revision cloud: the rectangle's outline as outward scallops (one cubic
 * Bézier bump per chord). Closed path, clockwise on screen. `arc` = target
 * chord length in page units (default {@link cloudArcSize}).
 */
export function cloudPath(r: Rect, arc: number = cloudArcSize(r)): string {
  const { x, y, width: w, height: h } = r;
  if (!(w > 0) || !(h > 0)) return rectPath(r);
  const corners: Point[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  let d = `M${f(x)} ${f(y)}`;
  for (let e = 0; e < 4; e++) {
    const a = corners[e];
    const b = corners[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(len / Math.max(1e-6, arc)));
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    // Outward normal for clockwise traversal in y-down space.
    const nx = uy;
    const ny = -ux;
    const seg = len / n;
    const bump = seg * 0.55;
    for (let i = 0; i < n; i++) {
      const p0x = a.x + ux * seg * i;
      const p0y = a.y + uy * seg * i;
      const p1x = p0x + ux * seg;
      const p1y = p0y + uy * seg;
      d += `C${f(p0x + nx * bump)} ${f(p0y + ny * bump)} ${f(p1x + nx * bump)} ${f(p1y + ny * bump)} ${f(p1x)} ${f(p1y)}`;
    }
  }
  return d + 'Z';
}

/** How far the cloud's scallops stick out beyond its rectangle (page units). */
export function cloudBulge(r: Rect, arc: number = cloudArcSize(r)): number {
  return arc * 0.55 * 0.75;
}

/** Arrow head length for a stroke width (same units). */
export function arrowHeadSize(strokeWidth: number = DEFAULT_STROKE_WIDTH): number {
  return Math.max(ARROW_HEAD_MIN, strokeWidth * ARROW_HEAD_FACTOR);
}

/**
 * Filled arrow-head triangle at `head`, pointing from `tail` to `head`:
 * [wing, tip (= head), other wing]. `size` = head length; `halfAngleDeg` its
 * half opening angle.
 */
export function arrowHeadPoints(tail: Point, head: Point, size: number, halfAngleDeg = 25): [Point, Point, Point] {
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = head.x - ux * size;
  const by = head.y - uy * size;
  const hw = size * Math.tan((halfAngleDeg * Math.PI) / 180);
  return [
    { x: bx - uy * hw, y: by + ux * hw },
    { x: head.x, y: head.y },
    { x: bx + uy * hw, y: by - ux * hw },
  ];
}

/** Where the shaft should end so it doesn't poke through the head's tip (base of the head). */
export function arrowShaftEnd(tail: Point, head: Point, size: number): Point {
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const len = Math.hypot(dx, dy);
  if (len <= size) return { ...tail };
  const t = (len - size * 0.8) / len;
  return { x: tail.x + dx * t, y: tail.y + dy * t };
}

/** Closed SVG path of the arrow head triangle. */
export function arrowHeadPath(tail: Point, head: Point, size: number): string {
  const [a, b, c] = arrowHeadPoints(tail, head, size);
  return `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}L${f(c.x)} ${f(c.y)}Z`;
}

/**
 * Note pin outline with its tip at `anchor`; `scale` = page units per pin
 * unit (viewer uses 1/zoom for a screen-constant pin; export e.g. 1).
 */
export function notePinPath(anchor: Point, scale = 1): string {
  const { headY: hy, radius: r } = NOTE_PIN;
  const P = (px: number, py: number) => `${f(anchor.x + px * scale)} ${f(anchor.y + py * scale)}`;
  // tip → left flank → round head (two cubic quarter… approximated by 4 arcs) → right flank → tip
  const k = 0.5523 * r;
  return (
    `M${P(0, 0)}` +
    `C${P(-3, -5)} ${P(-r, -hy + 6)} ${P(-r, -hy)}` +
    `C${P(-r, -hy - k)} ${P(-k, -hy - r)} ${P(0, -hy - r)}` +
    `C${P(k, -hy - r)} ${P(r, -hy - k)} ${P(r, -hy)}` +
    `C${P(r, -hy + 6)} ${P(3, -5)} ${P(0, 0)}Z`
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function textLines(text: string | undefined): string[] {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return lines.length ? lines : [''];
}

/**
 * Baselines of a 'text' markup. The anchor is the TOP-RIGHT corner of the
 * text block (Hebrew, right-aligned): each line ends at `x` (right edge) and
 * sits on baseline `y`. Export: draw each line at x - textWidth(line).
 */
export function textLineBaselines(anchor: Point, text: string | undefined, fontSize: number): { text: string; x: number; y: number }[] {
  return textLines(text).map((t, i) => ({ text: t, x: anchor.x, y: anchor.y + fontSize * (0.9 + i * TEXT_LINE_HEIGHT) }));
}

/** Rough bounds of a 'text' markup (0.55 em per character) — for hit testing / selection boxes. */
export function estimateTextBounds(anchor: Point, text: string | undefined, fontSize: number): Rect {
  const lines = textLines(text);
  const chars = Math.max(1, ...lines.map((l) => l.length));
  const width = chars * fontSize * 0.55;
  const height = fontSize * ((lines.length - 1) * TEXT_LINE_HEIGHT + 1.15);
  return { x: anchor.x - width, y: anchor.y, width, height };
}

// ---------------------------------------------------------------------------
// Freehand simplification
// ---------------------------------------------------------------------------

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Ramer–Douglas–Peucker polyline simplification (iterative; keeps first + last point). */
export function simplifyRDP(points: Point[], tolerance: number): Point[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let best = -1;
    let bestD = tolerance;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i], points[s], points[e]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Hit testing / bounds / move
// ---------------------------------------------------------------------------

export interface MarkupLike {
  kind?: string;
  points: Point[];
  text?: string;
  fontSize?: number;
  strokeWidth?: number;
}

export function translatePoints(points: Point[], dx: number, dy: number): Point[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

function polyDist(p: Point, pts: Point[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, segDist(p, pts[i], pts[i + 1]));
  return best;
}

function inRect(p: Point, r: Rect, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
}

/** Distance from p to the outline of r. */
export function distanceToRectEdge(p: Point, r: Rect): number {
  const c: Point[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
    { x: r.x, y: r.y },
  ];
  return polyDist(p, c);
}

/**
 * Bounding box of a markup in page units. `pinScale` = page units per screen
 * px (1/zoom) for the screen-constant note pin.
 */
export function markupBounds(m: MarkupLike, pinScale = 1): Rect {
  const pts = m.points;
  if (m.kind === 'note' && pts.length) {
    const { headY, radius } = NOTE_PIN;
    return {
      x: pts[0].x - radius * pinScale,
      y: pts[0].y - (headY + radius) * pinScale,
      width: 2 * radius * pinScale,
      height: (headY + radius) * pinScale,
    };
  }
  if (m.kind === 'text' && pts.length) return estimateTextBounds(pts[0], m.text, m.fontSize ?? 12);
  if (m.kind === 'cloud') {
    const r = rectOfPoints(pts);
    const b = cloudBulge(r);
    return { x: r.x - b, y: r.y - b, width: r.width + 2 * b, height: r.height + 2 * b };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Is page point p on markup m? `slop` = hit tolerance in page units;
 * `pinScale` = page units per screen px (for the note pin).
 * Rect / cloud are hit on their outline only (so takeoff areas inside stay
 * clickable); highlight and text anywhere inside.
 */
export function hitMarkup(p: Point, m: MarkupLike, slop: number, pinScale = 1): boolean {
  const pts = m.points;
  if (!pts.length) return false;
  switch (m.kind) {
    case 'note': {
      const { headY, radius } = NOTE_PIN;
      const c = { x: pts[0].x, y: pts[0].y - headY * pinScale };
      return Math.hypot(p.x - c.x, p.y - c.y) <= (radius + 3) * pinScale || Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= slop;
    }
    case 'text':
      return inRect(p, markupBounds(m), slop);
    case 'highlight':
    case 'link':
      return inRect(p, rectOfPoints(pts), slop);
    case 'rect':
      return distanceToRectEdge(p, rectOfPoints(pts)) <= slop;
    case 'cloud': {
      const r = rectOfPoints(pts);
      return distanceToRectEdge(p, r) <= slop + cloudBulge(r);
    }
    case 'ellipse':
    case 'triangle':
    case 'diamond': {
      const o = shapeOutline(m.kind, rectOfPoints(pts));
      return polyDist(p, [...o, o[0]]) <= slop + ((m.strokeWidth ?? DEFAULT_STROKE_WIDTH) / 2) * pinScale;
    }
    case 'line':
    case 'arrow':
    case 'pen':
      return polyDist(p, pts) <= slop + ((m.strokeWidth ?? DEFAULT_STROKE_WIDTH) / 2) * pinScale;
    default:
      return false;
  }
}
