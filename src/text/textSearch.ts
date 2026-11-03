/**
 * Pure text search over page TextItems + element-tag detection
 * ("חיפוש וספירה"). No pdf.js / React.
 */
import type { Rect, TextItem } from '../core/types';
import { substringRect } from './textGeometry';

export interface SearchOptions {
  wholeWord: boolean;
  /** false = case-insensitive (default). */
  caseSensitive: boolean;
  regex: boolean;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { wholeWord: true, caseSensitive: false, regex: false };

export interface TextMatch {
  /** Global page number. */
  page: number;
  itemIndex: number;
  start: number;
  end: number;
  /** Matched text as it appears on the drawing. */
  text: string;
  /** Bounds of the match (page units). */
  rect: Rect;
  /** The whole text run (for the results list). */
  context: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = String.raw`[\p{L}\p{N}_]`;

/** Compiles a query; throws a readable Error for an invalid regex. Returns null for an empty query. */
export function buildMatcher(query: string, opts: SearchOptions): RegExp | null {
  const q = opts.regex ? query : query.trim();
  if (!q) return null;
  let src = opts.regex ? q : escapeRe(q).replace(/\s+/g, '\\s+');
  if (opts.wholeWord) src = `(?<!${WORD})(?:${src})(?!${WORD})`;
  try {
    return new RegExp(src, 'gu' + (opts.caseSensitive ? '' : 'i'));
  } catch (e) {
    throw new Error(`ביטוי רגולרי שגוי: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** All matches of `re` (global) in one page's items. */
export function findInItems(items: readonly TextItem[], page: number, re: RegExp, limit = Infinity): TextMatch[] {
  const out: TextMatch[] = [];
  for (let i = 0; i < items.length && out.length < limit; i++) {
    const it = items[i];
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(it.str)) && out.length < limit; ) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      out.push({ page, itemIndex: i, start, end, text: m[0], rect: substringRect(it, start, end), context: it.str });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Likely element tags (W1, D2, CW-1, AL-12A …)
// ---------------------------------------------------------------------------

export const TAG_RE = /^[A-Z]{1,3}-?\d{1,3}[A-Z]?$/;
/** Paper sizes / common non-tags that look like tags. */
const NOT_TAGS = new Set(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'M2', 'M3']);

export interface TagCount {
  tag: string;
  count: number;
}

/** Tokens of every run that look like element tags, with their counts (most frequent first). */
export function detectTags(items: readonly TextItem[], minCount = 1): TagCount[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const raw of it.str.split(/[\s,;()[\]{}]+/)) {
      const tok = raw.replace(/^[.:'"״׳]+|[.:'"״׳]+$/g, '');
      if (!tok || !TAG_RE.test(tok) || NOT_TAGS.has(tok)) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, c]) => c >= minCount)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'en', { numeric: true }));
}
