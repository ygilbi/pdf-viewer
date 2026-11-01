/**
 * Pure helpers for the multi-file workspace: global <-> local page mapping of
 * measurements / calibrations and renumbering when a file is removed.
 * (Global page = doc.pageOffset + local page; see WorkspaceDoc in core/types.)
 */
import { withOffsets } from '../core/workspaceMap';
import type { AreaMeasurement, Calibration, PageSize, WorkspaceDoc } from '../core/types';

type DocPages = Pick<WorkspaceDoc, 'id' | 'numPages' | 'pageOffset'>;

/** Recomputes pageOffset from list order (keeps object identity when unchanged). */
export const layoutDocs = withOffsets;

/** Concatenated page count + sizes of all docs (the store's numPages / pageSizes). */
export function concatPages(docs: readonly Pick<WorkspaceDoc, 'numPages' | 'pageSizes'>[]): {
  numPages: number;
  pageSizes: PageSize[];
} {
  const pageSizes: PageSize[] = [];
  for (const d of docs) pageSizes.push(...d.pageSizes);
  return { numPages: pageSizes.length, pageSizes };
}

/** The doc that contains global page `page` (or undefined). */
export function docAtPage<D extends DocPages>(docs: readonly D[], page: number): D | undefined {
  return docs.find((d) => page > d.pageOffset && page <= d.pageOffset + d.numPages);
}

const inDoc = (d: DocPages, page: number) => page > d.pageOffset && page <= d.pageOffset + d.numPages;

/** This doc's measurements + calibrations with LOCAL page numbers (for persistence). */
export function extractDocData(
  doc: DocPages,
  measurements: readonly AreaMeasurement[],
  calibrations: Readonly<Record<number, Calibration>>,
): { measurements: AreaMeasurement[]; calibrations: Record<number, Calibration> } {
  const ms = measurements.filter((m) => inDoc(doc, m.page)).map((m) => ({ ...m, page: m.page - doc.pageOffset }));
  const cals: Record<number, Calibration> = {};
  for (const [k, c] of Object.entries(calibrations)) {
    const p = Number(k);
    if (inDoc(doc, p)) cals[p - doc.pageOffset] = c;
  }
  return { measurements: ms, calibrations: cals };
}

/** Local-page data of `doc` → global page numbers (drops pages outside the doc). */
export function toGlobalData(
  doc: DocPages,
  measurements: readonly AreaMeasurement[],
  calibrations: Readonly<Record<number, Calibration>>,
): { measurements: AreaMeasurement[]; calibrations: Record<number, Calibration> } {
  const ok = (p: number) => Number.isInteger(p) && p >= 1 && p <= doc.numPages;
  const ms = measurements.filter((m) => ok(m.page)).map((m) => ({ ...m, page: m.page + doc.pageOffset }));
  const cals: Record<number, Calibration> = {};
  for (const [k, c] of Object.entries(calibrations)) {
    const p = Number(k);
    if (ok(p)) cals[p + doc.pageOffset] = c;
  }
  return { measurements: ms, calibrations: cals };
}

export interface WorkspaceSlice {
  docs: WorkspaceDoc[];
  measurements: AreaMeasurement[];
  calibrations: Record<number, Calibration>;
  currentPage: number;
}

/**
 * Removes `docId`: drops its measurements/calibrations, shifts later docs'
 * pages down by its page count, re-lays out offsets and adjusts currentPage
 * (a page inside the removed doc moves to the page that now takes its first
 * page's place, clamped to the new total). Returns null for an unknown id.
 */
export function removeDocFromWorkspace(s: WorkspaceSlice, docId: string): (WorkspaceSlice & { numPages: number; pageSizes: PageSize[] }) | null {
  const doc = s.docs.find((d) => d.id === docId);
  if (!doc) return null;
  const n = doc.numPages;
  const end = doc.pageOffset + n;
  const shift = (p: number) => (p > end ? p - n : p);
  const measurements = s.measurements.filter((m) => !inDoc(doc, m.page)).map((m) => (m.page > end ? { ...m, page: m.page - n } : m));
  const calibrations: Record<number, Calibration> = {};
  for (const [k, c] of Object.entries(s.calibrations)) {
    const p = Number(k);
    if (!inDoc(doc, p)) calibrations[shift(p)] = c;
  }
  const docs = layoutDocs(s.docs.filter((d) => d.id !== docId));
  const { numPages, pageSizes } = concatPages(docs);
  let currentPage = inDoc(doc, s.currentPage) ? doc.pageOffset + 1 : shift(s.currentPage);
  currentPage = numPages === 0 ? 1 : Math.min(Math.max(1, currentPage), numPages);
  return { docs, measurements, calibrations, currentPage, numPages, pageSizes };
}
