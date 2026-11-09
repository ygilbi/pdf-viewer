import { rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { toVisual } from './bidi';

export interface FontPair {
  regular: PDFFont;
  bold: PDFFont;
}

export function hexColor(hex: string | undefined, fallback = '#64748b'): RGB {
  const h = /^#([0-9a-f]{6})$/i.exec(hex ?? '')?.[1] ?? fallback.slice(1);
  const n = parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export const BLACK = rgb(0.1, 0.11, 0.13);
export const WHITE = rgb(1, 1, 1);
export const GREY = rgb(0.42, 0.45, 0.5);

/**
 * fontkit (used by pdf-lib for custom fonts) reverses the WHOLE glyph run when
 * the first character with a non-Common script is RTL (no bidi, no mirroring).
 * Mirrors fontkit's `Script.forString` closely enough for Hebrew / Latin text.
 */
export function fontkitReverses(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f) || (cp >= 0x0600 && cp <= 0x06ff)) return true;
    if (/\p{L}/u.test(ch)) return false;
  }
  return false;
}

/** String to hand to pdf-lib so that the glyphs end up in `visual` (left-to-right) order. */
export function forPdfLib(visual: string): string {
  return fontkitReverses(visual) ? Array.from(visual).reverse().join('') : visual;
}

/**
 * Text ready for `drawText` + its advance width. `visual` is the whole line in visual
 * (left-to-right) order; `parts` are the pieces to hand to pdf-lib, each at `dx` from the left
 * edge. fontkit decides on reversing a WHOLE run by its first strong script, so a line that
 * mixes Hebrew and Latin (e.g. "זיגוג Low-E") cannot be passed as one string; it is split into
 * single-script pieces, each compensated with `forPdfLib`. Characters the font lacks are dropped
 * (pdf-lib would draw .notdef boxes).
 */
export function shape(
  font: PDFFont,
  text: string,
  size: number,
  rtl?: boolean,
): { visual: string; width: number; parts: { text: string; dx: number }[] } {
  const clean = supportedText(font, text.replace(/[\r\n\t]+/g, ' '));
  const visual = toVisual(clean, rtl);
  const parts: { text: string; dx: number }[] = [];
  let dx = 0;
  for (const chunk of scriptChunks(visual)) {
    const t = forPdfLib(chunk);
    parts.push({ text: t, dx });
    dx += font.widthOfTextAtSize(t, size);
  }
  return { visual, width: dx, parts };
}

/** Draw a `shape`d line with its left edge at (x, y) (unrotated page space). */
export function drawShaped(page: PDFPage, s: ReturnType<typeof shape>, x: number, y: number, o: { size: number; font: PDFFont; color: RGB }) {
  for (const p of s.parts) if (p.text.trim()) page.drawText(p.text, { x: x + p.dx, y, ...o });
}

/** Split visual-order text into runs whose letters are all Hebrew or all non-Hebrew. */
function scriptChunks(visual: string): string[] {
  const out: string[] = [];
  let cur = '';
  let cls: 'h' | 'l' | null = null;
  for (const ch of visual) {
    const cp = ch.codePointAt(0)!;
    const c: 'h' | 'l' | null = (cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f) || (cp >= 0x0600 && cp <= 0x06ff) ? 'h' : /\p{L}/u.test(ch) ? 'l' : null;
    if (c && cls && c !== cls) {
      out.push(cur);
      cur = '';
    }
    if (c) cls = c;
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const supportCache = new WeakMap<PDFFont, Set<number>>();
function supportedText(font: PDFFont, text: string): string {
  let set = supportCache.get(font);
  if (!set) {
    try {
      set = new Set(font.getCharacterSet());
    } catch {
      set = new Set();
    }
    supportCache.set(font, set);
  }
  if (set.size === 0) return text;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (set.has(cp)) out += ch;
    else if (cp === 0xb2) out += '2'; // ² → 2 (Alef has no superscripts)
    else if (cp === 0x2212) out += '-';
    else if (/\s/.test(ch)) out += ' ';
  }
  return out;
}

/** Greedy word wrap (measured on logical text — widths do not depend on order). */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && shape(font, next, size).width > maxWidth) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** `text` cut to fit `maxWidth`, with a trailing ellipsis when shortened. */
export function ellipsize(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (shape(font, text, size).width <= maxWidth) return text;
  const chars = Array.from(text.trimEnd());
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (shape(font, chars.slice(0, mid).join('').trimEnd() + '…', size).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo ? chars.slice(0, lo).join('').trimEnd() + '…' : '…';
}

/**
 * Word wrap for table cells: like `wrapText`, but words wider than the cell are broken, and the
 * result is limited to `maxLines` (the last kept line ends with an ellipsis when text was cut).
 */
export function wrapCell(font: PDFFont, text: string, size: number, maxWidth: number, maxLines = Infinity): string[] {
  const fits = (t: string) => shape(font, t, size).width <= maxWidth;
  const out: string[] = [];
  for (const line of wrapText(font, text, size, maxWidth)) {
    if (fits(line)) {
      out.push(line);
      continue;
    }
    // a single overlong word (wrapText never splits words): hard-break it
    let rest = Array.from(line);
    while (rest.length) {
      let n = rest.length;
      while (n > 1 && !fits(rest.slice(0, n).join(''))) n--;
      out.push(rest.slice(0, n).join(''));
      rest = rest.slice(n);
    }
  }
  if (out.length <= maxLines) return out;
  const kept = out.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(font, `${kept[maxLines - 1]} ${out[maxLines]}`, size, maxWidth);
  return kept;
}

export const svgNum = (n: number) => (Math.round(n * 100) / 100).toString();
