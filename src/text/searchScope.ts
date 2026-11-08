/**
 * Pure helpers for the file-aware text search: which pages a scope covers,
 * grouping results by file → page, and files without a text layer.
 * No pdf.js / React imports (unit-tested).
 */
import type { WorkspaceDoc } from '../core/types';

export type SearchScope = 'page' | 'doc' | 'all';

type DocPages = Pick<WorkspaceDoc, 'id' | 'numPages' | 'pageOffset'>;

const docOf = <D extends DocPages>(docs: readonly D[], page: number): D | undefined =>
  docs.find((d) => page > d.pageOffset && page <= d.pageOffset + d.numPages);

/**
 * Global pages to scan for `scope`, current page first, then the rest in
 * order. 'doc' = the file that contains the current page.
 */
export function pagesForScope(scope: SearchScope, docs: readonly DocPages[], currentPage: number, numPages: number): number[] {
  if (numPages <= 0) return [];
  const cur = Math.min(Math.max(1, currentPage), numPages);
  if (scope === 'page') return [cur];
  let from = 1;
  let to = numPages;
  if (scope === 'doc') {
    const d = docOf(docs, cur);
    if (d) {
      from = d.pageOffset + 1;
      to = d.pageOffset + d.numPages;
    }
  }
  const out = [cur];
  for (let p = from; p <= to; p++) if (p !== cur) out.push(p);
  return out;
}

export interface PageGroup<T> {
  page: number;
  /** Page number inside its file. */
  localPage: number;
  items: { m: T; i: number }[];
}

export interface DocGroup<T> {
  /** null = results on pages outside every known doc (should not happen). */
  doc: { id: string; name: string } | null;
  count: number;
  pages: PageGroup<T>[];
}

/**
 * Groups results (sorted by global page) into file → page groups, keeping
 * each result's index in the flat list (for goTo / the active row).
 */
export function groupResultsByDoc<T extends { page: number }>(
  results: readonly T[],
  docs: readonly (DocPages & { name: string })[],
): DocGroup<T>[] {
  const out: DocGroup<T>[] = [];
  results.forEach((m, i) => {
    const d = docOf(docs, m.page) ?? null;
    let g = out[out.length - 1];
    if (!g || (g.doc?.id ?? null) !== (d?.id ?? null)) {
      g = { doc: d ? { id: d.id, name: d.name } : null, count: 0, pages: [] };
      out.push(g);
    }
    g.count++;
    const last = g.pages[g.pages.length - 1];
    if (last && last.page === m.page) last.items.push({ m, i });
    else g.pages.push({ page: m.page, localPage: d ? m.page - d.pageOffset : m.page, items: [{ m, i }] });
  });
  return out;
}

/**
 * Docs whose every page was scanned and none had any text runs
 * (scanned drawings / text converted to curves).
 */
export function docsWithoutText<D extends DocPages>(
  docs: readonly D[],
  scanned: ReadonlySet<number>,
  pagesWithText: ReadonlySet<number>,
): D[] {
  return docs.filter((d) => {
    if (d.numPages === 0) return false;
    for (let p = d.pageOffset + 1; p <= d.pageOffset + d.numPages; p++) {
      if (!scanned.has(p) || pagesWithText.has(p)) return false;
    }
    return true;
  });
}
