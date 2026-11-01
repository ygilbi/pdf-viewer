/** Page-range parsing / formatting for the export dialog ("1-3,7"). Pages are 1-based global numbers. */

export type RangeParse = { ok: true; pages: number[] } | { ok: false; error: string };

/** Parse "1-3, 7, 10-" style input. Empty input → no pages. Accepts en/em dashes and Hebrew commas. */
export function parsePageRanges(text: string, maxPage: number): RangeParse {
  const out = new Set<number>();
  const parts = text
    .replace(/[–—־]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .split(/[,،;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    let a: number, b: number;
    if (m && (m[1] || m[2])) {
      a = m[1] ? parseInt(m[1], 10) : 1;
      b = m[2] ? parseInt(m[2], 10) : maxPage;
    } else if (/^\d+$/.test(part)) {
      a = b = parseInt(part, 10);
    } else {
      return { ok: false, error: `טווח לא תקין: "${part}"` };
    }
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > maxPage) return { ok: false, error: `הדפים חייבים להיות בין 1 ל־${maxPage}` };
    for (let p = a; p <= b; p++) out.add(p);
  }
  return { ok: true, pages: [...out].sort((x, y) => x - y) };
}

/** Compact range string of a page set: [1,2,3,7] → "1-3,7". */
export function formatPageRanges(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}
