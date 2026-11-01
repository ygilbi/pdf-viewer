/** Pure global <-> local page mapping for the multi-file workspace (no pdf.js imports; safe in tests). */
import type { PageLocation, WorkspaceDoc } from './types';

/** Recomputes `pageOffset` of every doc from its position (returns new objects only where changed). */
export function withOffsets<D extends { numPages: number; pageOffset: number }>(docs: readonly D[]): D[] {
  let off = 0;
  return docs.map((d) => {
    const next = d.pageOffset === off ? d : { ...d, pageOffset: off };
    off += d.numPages;
    return next;
  });
}

/** Maps a global 1-based page to (docId, localPage); null when out of range. */
export function locatePage(
  docs: readonly Pick<WorkspaceDoc, 'id' | 'numPages' | 'pageOffset'>[],
  globalPage: number,
): PageLocation | null {
  if (!Number.isFinite(globalPage)) return null;
  for (const d of docs) {
    if (globalPage > d.pageOffset && globalPage <= d.pageOffset + d.numPages) {
      return { docId: d.id, localPage: globalPage - d.pageOffset };
    }
  }
  return null;
}

/** Maps (docId, localPage) to the global page number; null when unknown. */
export function globalPageOf(
  docs: readonly Pick<WorkspaceDoc, 'id' | 'numPages' | 'pageOffset'>[],
  docId: string,
  localPage: number,
): number | null {
  const d = docs.find((x) => x.id === docId);
  if (!d || localPage < 1 || localPage > d.numPages) return null;
  return d.pageOffset + localPage;
}

