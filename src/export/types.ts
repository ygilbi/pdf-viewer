import type { AreaMeasurement, Calibration, Category, PageSize } from '../core/types';
import type { Boq } from '../pricing/boq';

export type ExportFormat = 'pdf' | 'csv' | 'xlsx';

export interface PdfContentOptions {
  /** Copy the original drawing pages (vector, via pdf-lib copyPages). Off → blank pages of the same size. */
  drawings: boolean;
  /** Takeoff measurements drawn over the page (areas, deductions, lengths, counts + labels). */
  measurements: boolean;
  /** Markup / annotations (rect, cloud, arrow, pen, highlight, text, note pins). */
  markup: boolean;
  /** Calibration reference line. */
  calibration: boolean;
  /**
   * Items table pages (טבלת פריטים) after the drawings: name · category · system · size · quantity ·
   * additional info, a subtotal per category and a grand total (core/itemTable).
   */
  items: boolean;
  /** Generic summary table pages at the end (per page, per category, totals, notes). */
  summary: boolean;
  /** Category legend (on every drawing page and in the summary). */
  legend: boolean;
  /** Priced bill of quantities page (כתב כמויות עם מחירים) at the end. */
  boq: boolean;
}

export const DEFAULT_PDF_OPTIONS: PdfContentOptions = {
  drawings: true,
  measurements: true,
  markup: true,
  calibration: true,
  // The owner's deliverable is "drawings with markings + the items table"; the generic quantity
  // summary stays available but is opt-in.
  items: true,
  summary: false,
  legend: false,
  boq: false,
};

/** One output page: a global page of the workspace and where it lives. */
export interface ExportPageSpec {
  globalPage: number;
  docId: string;
  /** 1-based page inside that doc. */
  localPage: number;
}

export interface ExportDocInfo {
  id: string;
  name: string;
}

export interface PdfBuildInput {
  docs: ExportDocInfo[];
  /** Original bytes per doc id (only docs that have pages in `pages`; required when options.drawings). */
  bytes: Record<string, ArrayBuffer | Uint8Array>;
  pages: ExportPageSpec[];
  /** Viewport size (pdf.js, scale 1) per global page — the space the geometry is stored in. */
  pageSizes: Record<number, PageSize>;
  measurements: AreaMeasurement[];
  calibrations: Record<number, Calibration>;
  categories: Category[];
  options: PdfContentOptions;
  fonts: { regular: ArrayBuffer | Uint8Array; bold: ArrayBuffer | Uint8Array };
  /** Document title (PDF metadata + summary heading). */
  title: string;
  /** Preformatted export date for the summary header. */
  dateText?: string;
  /** Priced BOQ for the selected pages (drawn when options.boq). */
  boq?: Boq;
}

export type ProgressStage = 'load' | 'pages' | 'summary' | 'save';
export type ProgressFn = (stage: ProgressStage, done: number, total: number) => void;

// ---- CSV ------------------------------------------------------------------

export interface CsvOptions {
  /** Items table (טבלת פריטים) first: owner's 6 columns, category subtotals, grand total. */
  items: boolean;
  /** One row per measurement. */
  rows: boolean;
  /** Per-category subtotal rows. */
  categoryTotals: boolean;
  /** Document totals rows (gross / deductions / net / length / count). */
  totals: boolean;
  /** Notes / text markup section. */
  notes: boolean;
  /** Takeoff kinds to include (empty = none). */
  kinds: Array<'area' | 'deduct' | 'length' | 'count'>;
  /** Category keys to include ('' = uncategorised); null = all. */
  categories: string[] | null;
}

export const DEFAULT_CSV_OPTIONS: CsvOptions = {
  items: false,
  rows: true,
  categoryTotals: true,
  totals: true,
  notes: true,
  kinds: ['area', 'deduct', 'length', 'count'],
  categories: null,
};
