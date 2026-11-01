/**
 * Where export gets the open files from: the store's workspace docs (reactive,
 * global page numbering) and the workspace client's original file bytes.
 */
import type { PageSize, WorkspaceDoc } from '../core/types';
import { getWorkspaceClient } from '../core/pdfClient';
import { locatePage } from '../core/workspaceMap';
import type { ExportPageSpec } from './types';

export type ExportDoc = Pick<WorkspaceDoc, 'id' | 'name' | 'numPages' | 'pageOffset'>;

/** Global pages → output page specs (sorted, i.e. in workspace order). */
export function pageSpecs(docs: readonly ExportDoc[], globalPages: Iterable<number>): ExportPageSpec[] {
  const out: ExportPageSpec[] = [];
  for (const g of [...new Set(globalPages)].sort((a, b) => a - b)) {
    const loc = locatePage(docs, g);
    if (loc) out.push({ globalPage: g, docId: loc.docId, localPage: loc.localPage });
  }
  return out;
}

/** Original bytes of an open file. */
export function docBytes(docId: string): Promise<ArrayBuffer> {
  return getWorkspaceClient().getFileBytes(docId);
}

export function pageSizeMap(pageSizes: PageSize[], pages: ExportPageSpec[]): Record<number, PageSize> {
  const out: Record<number, PageSize> = {};
  for (const p of pages) if (pageSizes[p.globalPage - 1]) out[p.globalPage] = pageSizes[p.globalPage - 1];
  return out;
}
