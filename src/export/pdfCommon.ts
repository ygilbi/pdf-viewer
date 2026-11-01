import { rgb, type PDFFont, type RGB } from 'pdf-lib';
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
 * Text ready for `drawText` (`visual` = what to pass to pdf-lib, already
 * compensated for fontkit) + its advance width. Characters the font lacks are
 * dropped (pdf-lib would draw .notdef boxes).
 */
export function shape(font: PDFFont, text: string, size: number, rtl?: boolean): { visual: string; width: number } {
  const clean = supportedText(font, text.replace(/[\r\n\t]+/g, ' '));
  const visual = forPdfLib(toVisual(clean, rtl));
  return { visual, width: font.widthOfTextAtSize(visual, size) };
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

export const svgNum = (n: number) => (Math.round(n * 100) / 100).toString();
