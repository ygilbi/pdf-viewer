/**
 * Minimal bidi (UBA-lite) for drawing mixed Hebrew / Latin / number text with
 * pdf-lib, which lays glyphs out strictly left-to-right and has no bidi.
 *
 * `toVisual(logical)` returns the string in *visual* (left-to-right drawing)
 * order: Hebrew runs reversed, numbers / Latin runs kept LTR, run order
 * flipped in RTL paragraphs, brackets mirrored inside RTL runs.
 *
 * Implemented subset of UAX #9 (single line, no explicit embeddings):
 *  - types: R (Hebrew), L (other letters), EN (digits, with in-number
 *    separators and a leading sign / trailing % joined), N (everything else)
 *  - W7: EN preceded (strongly) by L becomes L
 *  - N1/N2: neutrals between equal strong types take that type (EN counts
 *    as R), otherwise the paragraph direction
 *  - I1/I2 levels, L2 reordering, L4 mirroring
 */

type BidiType = 'R' | 'L' | 'EN' | 'N';

const isHebrew = (cp: number) => (cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f);
const isDigit = (cp: number) => cp >= 0x30 && cp <= 0x39;
const isLetterL = (ch: string, cp: number) =>
  !isHebrew(cp) && cp > 0x40 && /\p{L}/u.test(ch);

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };

/** Paragraph direction from the first strong character (default RTL when none — Hebrew UI). */
export function paragraphIsRtl(text: string, fallbackRtl = true): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isHebrew(cp)) return true;
    if (isLetterL(ch, cp)) return false;
  }
  return fallbackRtl;
}

function classify(chars: string[]): BidiType[] {
  const n = chars.length;
  const t: BidiType[] = chars.map((ch) => {
    const cp = ch.codePointAt(0)!;
    if (isHebrew(cp)) return 'R';
    if (isDigit(cp)) return 'EN';
    if (isLetterL(ch, cp)) return 'L';
    return 'N';
  });
  const digitAt = (i: number) => i >= 0 && i < n && isDigit(chars[i].codePointAt(0)!);
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'N') continue;
    const c = chars[i];
    // separators inside a number: 1,234.5  12:30  1/2
    if ((c === '.' || c === ',' || c === ':' || c === '/') && digitAt(i - 1) && digitAt(i + 1)) t[i] = 'EN';
    // leading sign / decimal point: -12  +3  .5 (only at a word start)
    else if ((c === '-' || c === '+' || c === '−' || c === '.') && digitAt(i + 1) && (i === 0 || /\s/.test(chars[i - 1])))
      t[i] = 'EN';
    // trailing percent / per-mille
    else if ((c === '%' || c === '‰') && digitAt(i - 1)) t[i] = 'EN';
  }
  return t;
}

/** Convert a single line of logical-order text to visual (LTR drawing) order. */
export function toVisual(text: string, rtl: boolean = paragraphIsRtl(text)): string {
  const chars = Array.from(text);
  const n = chars.length;
  if (n === 0) return '';
  const types = classify(chars);
  const e: 'L' | 'R' = rtl ? 'R' : 'L';

  // W7: EN after strong L (or sos L) → L.
  let lastStrong: 'L' | 'R' = e;
  for (let i = 0; i < n; i++) {
    const ty = types[i];
    if (ty === 'L' || ty === 'R') lastStrong = ty;
    else if (ty === 'EN' && lastStrong === 'L') types[i] = 'L';
  }

  // N1/N2: resolve neutral runs.
  const strongOf = (ty: BidiType): 'L' | 'R' | null => (ty === 'L' ? 'L' : ty === 'R' || ty === 'EN' ? 'R' : null);
  for (let i = 0; i < n; ) {
    if (types[i] !== 'N') {
      i++;
      continue;
    }
    let j = i;
    while (j < n && types[j] === 'N') j++;
    const before = i > 0 ? strongOf(types[i - 1]) : e;
    const after = j < n ? strongOf(types[j]) : e;
    const res: BidiType = before === after && before ? before : e;
    for (let k = i; k < j; k++) types[k] = res;
    i = j;
  }

  // I1/I2: embedding levels.
  const base = rtl ? 1 : 0;
  const levels = types.map((ty) => {
    if (base === 0) return ty === 'R' ? 1 : ty === 'EN' ? 2 : 0;
    return ty === 'R' ? 1 : 2; // L or EN at odd base
  });

  // L2: reverse from the highest level down to the lowest odd level.
  const order = chars.map((_, i) => i);
  const maxLevel = Math.max(...levels);
  for (let lvl = maxLevel; lvl >= 1; lvl--) {
    for (let i = 0; i < n; ) {
      if (levels[order[i]] < lvl) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && levels[order[j]] >= lvl) j++;
      const seg = order.slice(i, j).reverse();
      for (let k = i; k < j; k++) order[k] = seg[k - i];
      i = j;
    }
  }

  // L4: mirror brackets at odd levels.
  return order.map((i) => (levels[i] % 2 === 1 && MIRROR[chars[i]] ? MIRROR[chars[i]] : chars[i])).join('');
}
