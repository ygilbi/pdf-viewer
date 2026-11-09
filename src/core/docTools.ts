/**
 * Pure geometry of the two document-editing tools (no DOM, no React — shared by the viewer,
 * hit testing and PDF export):
 *
 *  - 'textEdit'  cover-and-replace: an opaque paper rectangle over an existing text run of the
 *                PDF (+ padding) with the replacement text on top. `points` = [cover top-left,
 *                cover bottom-right].
 *  - 'signature' a placed signature image. `points` = [image top-left, image bottom-right], the
 *                aspect ratio is locked on resize; optional date line (`text`) under the image.
 *
 * All in page units (top-left origin, y down), like every other markup.
 */
import type { Point, Rect, TextItem } from './types';

/** Cover padding around the original run, in multiples of its font size. */
export const TEXT_EDIT_PAD = 0.15;
/** Fraction of the font size below the baseline (matches textGeometry's 1 - ASCENT). */
export const TEXT_EDIT_DESCENT = 0.2;
/** Average glyph advance (em) used when no original run gives a better estimate. */
const DEFAULT_CHAR_EM = 0.55;
/** Replacement text colour when the markup style has no explicit colour. */
export const TEXT_EDIT_COLOR = '#000000';
/** Paper colour of the cover rectangle. */
export const PAPER_COLOR = '#ffffff';

/** Font size (page units) of a text run: the length of its quad's "up" vector. */
export function runFontSize(item: Pick<TextItem, 'q'>): number {
  return Math.hypot(item.q[4], item.q[5]);
}

/**
 * True for runs the edit tool supports: horizontal, left-to-right baseline on screen (Hebrew runs
 * too — their baseline also points right; only the character order is reversed). Rotated /
 * vertical runs (common for dimension text) are skipped.
 */
export function isEditableRun(item: Pick<TextItem, 'q' | 'str'>): boolean {
  const [, , ux, uy] = item.q;
  return !!item.str.trim() && ux > 0 && Math.abs(uy) <= ux * 0.08 && runFontSize(item) > 0;
}

/**
 * The text run under page point `p` (index into `items`, -1 = none). Overlapping candidates: the
 * smallest one wins (a word inside a long line, a label inside a title block). `slop` (page units)
 * widens every run for easier hits.
 */
export function findTextRunAt(items: readonly TextItem[], p: Point, slop = 0): number {
  let best = -1;
  let bestArea = Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!isEditableRun(it)) continue;
    const r = it.rect;
    if (p.x < r.x - slop || p.x > r.x + r.width + slop || p.y < r.y - slop || p.y > r.y + r.height + slop) continue;
    const a = r.width * r.height;
    if (a < bestArea) {
      bestArea = a;
      best = i;
    }
  }
  return best;
}

/** Cover rectangle (run bounds + padding) for a run. */
export function runCoverRect(item: Pick<TextItem, 'rect' | 'q'>): Rect {
  const pad = runFontSize(item) * TEXT_EDIT_PAD;
  const r = item.rect;
  return { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
}

/** The fields of a new 'textEdit' markup that replaces run `item` (text prefilled with the original). */
export function textEditFromRun(item: TextItem): { points: Point[]; text: string; origText: string; fontSize: number; rtl: boolean } {
  const c = runCoverRect(item);
  const fs = Math.round(runFontSize(item) * 100) / 100;
  return {
    points: [
      { x: c.x, y: c.y },
      { x: c.x + c.width, y: c.y + c.height },
    ],
    text: item.str,
    origText: item.str,
    fontSize: fs,
    rtl: !!item.rtl,
  };
}

/** Font size for text typed into a box drawn by hand (scans without a text layer). */
export function boxFontSize(r: Rect): number {
  return Math.max(1, Math.round(r.height * 0.6 * 100) / 100);
}

export interface TextEditLike {
  points: Point[];
  text?: string;
  origText?: string;
  fontSize?: number;
  rtl?: boolean;
}

/** Original cover rectangle (as placed). */
export function textEditBaseRect(m: TextEditLike): Rect {
  const [a, b] = [m.points[0], m.points[1] ?? m.points[0]];
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

export const textEditFontSize = (m: TextEditLike): number => (m.fontSize && m.fontSize > 0 ? m.fontSize : 12);

/**
 * Estimated advance of `text` in the viewer: the original run's own average glyph width when known
 * (so a replacement of similar length keeps the same width), else 0.55 em per character.
 */
export function estimateTextWidth(m: TextEditLike, text: string = m.text ?? ''): number {
  const fs = textEditFontSize(m);
  const n = Array.from(text).length;
  const orig = Array.from(m.origText ?? '').length;
  if (orig > 0) {
    const inner = textEditBaseRect(m).width - 2 * fs * TEXT_EDIT_PAD;
    if (inner > 0) return (inner / orig) * n;
  }
  return n * fs * DEFAULT_CHAR_EM;
}

/**
 * Effective cover: the placed rectangle, widened when the replacement is longer than the original
 * — towards the reading direction (RTL grows to the left, LTR to the right). `textWidth` = the
 * replacement's real advance when known (export measures it with the embedded font).
 */
export function textEditCoverRect(m: TextEditLike, textWidth: number = estimateTextWidth(m)): Rect {
  const r = textEditBaseRect(m);
  const need = textWidth + 2 * textEditFontSize(m) * TEXT_EDIT_PAD;
  if (need <= r.width) return r;
  return m.rtl ? { ...r, x: r.x + r.width - need, width: need } : { ...r, width: need };
}

/**
 * Where to draw the replacement: baseline `y`, and the x of its START edge in reading order —
 * the right edge (minus padding) for RTL, the left edge (plus padding) for LTR.
 */
export function textEditBaseline(m: TextEditLike, cover: Rect = textEditCoverRect(m)): { x: number; y: number; rtl: boolean } {
  const fs = textEditFontSize(m);
  const pad = fs * TEXT_EDIT_PAD;
  const rtl = !!m.rtl;
  // Vertically: keep the original baseline (bottom padding + descent); for a hand-drawn box that is
  // taller than the text, centre the glyphs instead.
  const natural = fs * (1 + 2 * TEXT_EDIT_PAD);
  const extra = Math.max(0, cover.height - natural) / 2;
  return {
    x: rtl ? cover.x + cover.width - pad : cover.x + pad,
    y: cover.y + cover.height - extra - pad - fs * TEXT_EDIT_DESCENT,
    rtl,
  };
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/** Date line font size for a signature box (page units). */
export function signatureDateSize(r: Rect): number {
  return Math.max(4, Math.min(r.height * 0.22, r.width * 0.12));
}

/** Baseline of the signature's date line (centred under the image). */
export function signatureDateBaseline(r: Rect): Point {
  const fs = signatureDateSize(r);
  return { x: r.x + r.width / 2, y: r.y + r.height + fs * 1.05 };
}

/** Bounds of a signature incl. its date line. */
export function signatureBounds(m: { points: Point[]; text?: string }): Rect {
  const r = textEditBaseRect(m);
  if (!(m.text ?? '').trim()) return r;
  const fs = signatureDateSize(r);
  return { ...r, height: r.height + fs * 1.35 };
}

/**
 * Default size of a newly placed signature (page units): ~180 screen px wide at the current zoom,
 * kept within a physically sensible 90–220 pt (3–8 cm) and half the page width.
 */
export function defaultSignatureSize(aspect: number, zoom: number, pageWidth: number): { width: number; height: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 3;
  let w = Math.min(220, Math.max(90, 180 / Math.max(zoom, 1e-6)));
  w = Math.min(w, pageWidth * 0.5);
  return { width: w, height: w / a };
}

/** Signature box centred on `at`. */
export function signatureBoxAt(at: Point, size: { width: number; height: number }): Point[] {
  return [
    { x: at.x - size.width / 2, y: at.y - size.height / 2 },
    { x: at.x + size.width / 2, y: at.y + size.height / 2 },
  ];
}

/**
 * Locked-aspect resize: corner `moving` follows the pointer `p`, the opposite corner `anchor`
 * stays. The new size follows the pointer's larger relative displacement; never smaller than
 * `minW` (page units) wide; the corner stays on its original side of the anchor.
 */
export function resizeLocked(anchor: Point, moving: Point, p: Point, aspect: number, minW = 4): Point {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const sx = Math.sign(moving.x - anchor.x) || 1;
  const sy = Math.sign(moving.y - anchor.y) || 1;
  const w0 = Math.max(0, (p.x - anchor.x) * sx);
  const h0 = Math.max(0, (p.y - anchor.y) * sy);
  const w = Math.max(minW, Math.max(w0, h0 * a));
  return { x: anchor.x + sx * w, y: anchor.y + sy * (w / a) };
}

/** Today's date as dd.mm.yyyy (Israeli format) for the signature's date line. */
export function formatSignatureDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}
