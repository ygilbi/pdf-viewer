/**
 * Automatic scale detection from the drawing's own text ("כיול אוטומטי") and
 * paper-size detection from the page size. Pure — no pdf.js / React.
 *
 * Page units are PDF points (1 pt = 1/72 inch). A drawing at 1:N printed at
 * 100% therefore has  pixelsPerMeter = (72 / 0.0254) / N  page units per meter.
 */
import type { Calibration, PageSize, Point, Rect, TextItem } from '../core/types';
import { substringRect } from './textGeometry';

/** Page units (PDF points) per real meter at 1:1. */
export const POINTS_PER_METER = 72 / 0.0254;

export function ppmForScale(denominator: number): number {
  return POINTS_PER_METER / denominator;
}

// ---------------------------------------------------------------------------
// Paper size
// ---------------------------------------------------------------------------

export type IsoA = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';
/** ISO 216 A sizes in mm, portrait (short × long). */
export const ISO_A: Record<IsoA, [number, number]> = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297],
};

export interface PaperSize {
  name: IsoA;
  orientation: 'landscape' | 'portrait';
  widthMm: number;
  heightMm: number;
}

export const ptToMm = (pt: number) => (pt * 25.4) / 72;

/** ISO A0–A4 match for a page size in points (±2% / ±3 mm), or null. */
export function detectPaperSize(size: PageSize | undefined): PaperSize | null {
  if (!size || !(size.width > 0 && size.height > 0)) return null;
  const w = ptToMm(size.width);
  const h = ptToMm(size.height);
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  for (const name of Object.keys(ISO_A) as IsoA[]) {
    const [s, l] = ISO_A[name];
    const tol = (v: number) => Math.max(3, v * 0.02);
    if (Math.abs(short - s) <= tol(s) && Math.abs(long - l) <= tol(l)) {
      return { name, orientation: w >= h ? 'landscape' : 'portrait', widthMm: Math.round(w), heightMm: Math.round(h) };
    }
  }
  return null;
}

/** "A2 לרוחב · 594×420 מ״מ" or "420×297 מ״מ" when not an A size. */
export function formatPaper(size: PageSize | undefined): string {
  if (!size) return '';
  const p = detectPaperSize(size);
  const dims = `${Math.round(ptToMm(size.width))}×${Math.round(ptToMm(size.height))} מ״מ`;
  if (!p) return dims;
  return `${p.name} ${p.orientation === 'landscape' ? 'לרוחב' : 'לאורך'} · ${dims}`;
}

// ---------------------------------------------------------------------------
// Parsing scale notations
// ---------------------------------------------------------------------------

/** Usual drawing scales — a bare "1:N" (no SCALE / קנ״מ prefix) is accepted only for these. */
const COMMON = new Set([5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000, 10000]);

export interface ScaleNotation {
  /** N of 1:N. */
  denominator: number;
  /** The matched text, e.g. "SCALE 1:100". */
  text: string;
  /** Index of the match in the parsed string / of the "1" of "1:N". */
  index: number;
  ratioIndex: number;
  ratioLength: number;
  /** Had an explicit prefix (SCALE / קנ״מ / M / …). */
  prefixed: boolean;
  /** Paper the scale refers to ("1:100 @ A1"), if stated. */
  paper?: IsoA;
}

const PREFIX = String.raw`(?:scale|sc\.?|m|massstab|maßstab|echelle|échelle|קנ["״׳'’]?מ|קנה[\s-]*מידה)`;
// prefix? ws  1 : N  (@ A1)?
const RE = new RegExp(
  String.raw`(?:(?<![\p{L}\p{N}])(?<prefix>${PREFIX})\.?\s*[:=]?\s*)?(?<![\p{N}.,:/])(?<ratio>1\s*[:：∶]\s*(?<n>\d{1,5}(?:[.,]\d+)?))(?![\p{N}:])(?:\s*(?:@|at|ב-?|על)\s*(?<paper>A[0-4])(?![\p{N}]))?`,
  'giu',
);

/** All scale notations in one string ("SCALE 1:100", "קנ״מ 1:50", "M 1:200", "1:100@A1", …). */
export function parseScaleNotations(s: string): ScaleNotation[] {
  const norm = s.replace(/[‎‏‪-‮]/g, (c) => ' '.repeat(c.length)); // bidi marks → keep indices
  const out: ScaleNotation[] = [];
  RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = RE.exec(norm)); ) {
    const g = m.groups!;
    const n = parseFloat(g.n.replace(',', '.'));
    const prefixed = !!g.prefix;
    if (!(n >= 1 && n <= 20000)) continue;
    if (!prefixed && !COMMON.has(n)) continue;
    const ratioIndex = m.index + m[0].indexOf(g.ratio);
    out.push({
      denominator: n,
      text: m[0].trim(),
      index: m.index,
      ratioIndex,
      ratioLength: g.ratio.length,
      prefixed,
      paper: g.paper ? (g.paper.toUpperCase() as IsoA) : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detection on a page
// ---------------------------------------------------------------------------

export interface DetectedScale {
  denominator: number;
  /** Page units per meter (adjusted when the notation names a different paper size than the page). */
  pixelsPerMeter: number;
  /** "1:100" (+ " @A1" when stated). */
  label: string;
  /** Number of occurrences on the page. */
  count: number;
  prefixed: boolean;
  /** Bounds of each occurrence (page units). */
  rects: Rect[];
  /** Notation said "@A1" but the page is another size → ppm rescaled by this factor. */
  paperFactor?: number;
}

const SCALE_WORD = new RegExp(String.raw`^\s*${PREFIX}\s*[:.]?\s*$`, 'iu');

/**
 * Scale notations on a page, one entry per distinct scale, most frequent first
 * (prefixed ones win ties). `pageSize` enables the "@A1" paper adjustment.
 */
export function detectScales(items: readonly TextItem[], pageSize?: PageSize): DetectedScale[] {
  const pagePaper = detectPaperSize(pageSize);
  const byKey = new Map<string, DetectedScale>();
  items.forEach((it, i) => {
    for (const n of parseScaleNotations(it.str)) {
      let prefixed = n.prefixed;
      // "SCALE" as its own run right before/after (title blocks: label above the value).
      if (!prefixed) {
        const near = [items[i - 1], items[i + 1]].filter(Boolean) as TextItem[];
        prefixed = near.some((o) => SCALE_WORD.test(o.str) && rectDist(o.rect, it.rect) < 3 * Math.max(it.rect.height, o.rect.height));
      }
      let factor: number | undefined;
      if (n.paper && pagePaper && n.paper !== pagePaper.name) {
        factor = ISO_A[pagePaper.name][1] / ISO_A[n.paper][1];
      }
      const key = `${n.denominator}|${factor ?? 1}`;
      let d = byKey.get(key);
      if (!d) {
        d = {
          denominator: n.denominator,
          pixelsPerMeter: ppmForScale(n.denominator) * (factor ?? 1),
          label: `1:${n.denominator}` + (n.paper ? ` @${n.paper}` : ''),
          count: 0,
          prefixed: false,
          rects: [],
          ...(factor ? { paperFactor: factor } : {}),
        };
        byKey.set(key, d);
      }
      d.count++;
      d.prefixed ||= prefixed;
      d.rects.push(substringRect(it, n.ratioIndex, n.ratioIndex + n.ratioLength));
    }
  });
  return [...byKey.values()].sort((a, b) => b.count - a.count || Number(b.prefixed) - Number(a.prefixed) || a.denominator - b.denominator);
}

function rectDist(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

/**
 * Calibration for a detected scale: a synthetic 1 m reference just below the
 * first occurrence (kept inside the page), flagged `auto`.
 */
export function calibrationFromScale(d: DetectedScale, pageSize?: PageSize): Calibration {
  const r = d.rects[0] ?? { x: 0, y: 0, width: 0, height: 0 };
  const len = d.pixelsPerMeter;
  let x = r.x;
  // Far enough below that the overlay's "1.00 מ׳" label (drawn above the line) clears the text.
  let y = r.y + r.height * 3.2 + 6;
  if (pageSize) {
    x = Math.min(Math.max(0, x), Math.max(0, pageSize.width - len));
    if (y > pageSize.height) y = Math.max(0, r.y - r.height * 2);
  }
  const p1: Point = { x, y };
  const p2: Point = { x: x + len, y };
  return { pixelsPerMeter: d.pixelsPerMeter, p1, p2, meters: 1, auto: true, source: d.label };
}
