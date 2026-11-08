/**
 * Pure logic of the file tab bar: the active tab, the last page viewed in each
 * file (so switching tabs returns to it) and tab cycling. No React / pdf.js.
 */
import type { WorkspaceDoc } from '../core/types';

type DocPages = Pick<WorkspaceDoc, 'id' | 'numPages' | 'pageOffset'>;

/** docId → last LOCAL page viewed in that file. */
export type LastPages = Readonly<Record<string, number>>;

/** Id of the doc that contains global `page` (null when none). */
export function activeDocId(docs: readonly DocPages[], page: number): string | null {
  return docs.find((d) => page > d.pageOffset && page <= d.pageOffset + d.numPages)?.id ?? null;
}

/** Records global `page` as the last page of the doc containing it (same object when unchanged). */
export function rememberPage(last: LastPages, docs: readonly DocPages[], page: number): LastPages {
  const d = docs.find((x) => page > x.pageOffset && page <= x.pageOffset + x.numPages);
  if (!d) return last;
  const local = page - d.pageOffset;
  return last[d.id] === local ? last : { ...last, [d.id]: local };
}

/** Global page to show when `doc`'s tab is clicked: its remembered page (clamped) or its first page. */
export function pageForTab(last: LastPages, doc: DocPages): number {
  const local = last[doc.id];
  const p = local && Number.isFinite(local) ? Math.min(Math.max(1, Math.round(local)), doc.numPages) : 1;
  return doc.pageOffset + p;
}

/** Drops entries of docs that are no longer open (same object when nothing changed). */
export function pruneLastPages(last: LastPages, docs: readonly Pick<WorkspaceDoc, 'id'>[]): LastPages {
  const ids = new Set(docs.map((d) => d.id));
  const keys = Object.keys(last);
  if (keys.every((k) => ids.has(k))) return last;
  const out: Record<string, number> = {};
  for (const k of keys) if (ids.has(k)) out[k] = last[k];
  return out;
}

/** Doc id `step` tabs away from `currentId` (wraps around). */
export function cycleDoc(docs: readonly Pick<WorkspaceDoc, 'id'>[], currentId: string | null, step: number): string | null {
  if (!docs.length) return null;
  const i = Math.max(0, docs.findIndex((d) => d.id === currentId));
  const n = docs.length;
  return docs[(((i + step) % n) + n) % n].id;
}

/** Ids present in `next` but not in `prev`, only when `prev` was non-empty and still overlaps (an append, not a replace). */
export function appendedDocIds(prev: readonly Pick<WorkspaceDoc, 'id'>[], next: readonly Pick<WorkspaceDoc, 'id'>[]): string[] {
  if (!prev.length) return [];
  const before = new Set(prev.map((d) => d.id));
  if (!next.some((d) => before.has(d.id))) return [];
  return next.filter((d) => !before.has(d.id)).map((d) => d.id);
}
