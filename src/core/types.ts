/**
 * Shared contracts between modules. Every module codes against these types.
 *
 * COORDINATE SYSTEM (critical):
 * All measurement geometry is stored in *PDF page units* — PDF points at
 * scale 1 (1pt = 1/72 inch), origin top-left of the page viewport (rotation
 * already applied, i.e. pdf.js `page.getViewport({ scale: 1 })` space).
 * This makes measurements independent of zoom level and render resolution.
 */

export interface Point {
  x: number;
  y: number;
}

/** Size of a page in page units (viewport at scale 1, rotation applied). */
export interface PageSize {
  width: number;
  height: number;
}

/** Axis-aligned rect in page units. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Worker protocol (main thread <-> src/core/pdfWorker.ts)
// ---------------------------------------------------------------------------

export type WorkerRequest =
  /** `docId` keys the document inside the worker (several may be open). Omitted = 'default'. */
  | { type: 'open'; file: File | ArrayBuffer; docId?: string }
  | {
      type: 'render';
      /** Unique id chosen by the client; echoed back in the response. */
      id: number;
      /** 1-based page number (local to `docId`'s document). */
      page: number;
      /** Document to render from (see `open`). Omitted = 'default'. */
      docId?: string;
      /** Output pixels per page unit. */
      scale: number;
      /**
       * Optional sub-region of the page (page units) to render. When omitted,
       * the whole page is rendered. Output bitmap size = region size * scale.
       */
      region?: Rect;
      /** Higher = sooner. Thumbnails use low priority. */
      priority: number;
    }
  | { type: 'cancel'; id: number }
  /** Change the priority of a queued or running render (e.g. a prefetch became the visible page). */
  | { type: 'priority'; id: number; priority: number }
  /** Close one document (`docId`) or, when omitted, all of them. */
  | { type: 'close'; docId?: string };

export type WorkerResponse =
  | { type: 'opened'; numPages: number; pageSizes: PageSize[]; docId?: string }
  | { type: 'rendered'; id: number; page: number; bitmap: ImageBitmap; scale: number; region: Rect }
  | { type: 'renderError'; id: number; message: string; cancelled?: boolean }
  | { type: 'error'; message: string; docId?: string };

// ---------------------------------------------------------------------------
// Client API (src/core/pdfClient.ts) — the only thing UI code talks to.
// ---------------------------------------------------------------------------

export interface RenderResult {
  bitmap: ImageBitmap;
  page: number;
  scale: number;
  region: Rect;
}

export interface RenderTask {
  promise: Promise<RenderResult>;
  cancel(): void;
  /** Change the priority while queued / running (no-op once finished). */
  setPriority?(priority: number): void;
}

export interface PdfDocumentInfo {
  numPages: number;
  pageSizes: PageSize[];
}

export interface PdfClient {
  open(file: File): Promise<PdfDocumentInfo>;
  render(opts: { page: number; scale: number; region?: Rect; priority?: number }): RenderTask;
  close(): void;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export type ToolId = 'pan' | 'calibrate' | 'area' | 'deduct' | 'length' | 'count' | MarkupKind;

/**
 * What a measurement represents:
 *  - 'area'   facade polygon (gross area)
 *  - 'deduct' opening (window/door) polygon subtracted from the area that
 *             contains its centroid on the same page
 *  - 'length' open polyline (≥2 points), measured by total length
 *  - 'count'  item count: each point is one marker (≥1 point), e.g. "W1 ×12"
 */
export type MeasurementKind = 'area' | 'deduct' | 'length' | 'count';

/** Work category (חלונות / ויטרינות / חיפוי …). Measurements reference it by `id`. */
export interface Category {
  id: string;
  name: string;
  color: string;
}

/** Per-page scale. pixelsPerMeter is in *page units per meter*. */
export interface Calibration {
  pixelsPerMeter: number;
  /** The two reference points and the length the user typed (for display). */
  p1: Point;
  p2: Point;
  meters: number;
}

export interface AreaMeasurement {
  id: string;
  page: number;
  label: string;
  /**
   * Missing on measurements saved before kinds existed → treat as 'area'.
   * Always read it through `kindOf(m)` (measurementEngine).
   */
  kind?: MeasurementKind | MarkupKind;
  /**
   * Vertices in page units. Polygon (closed implicitly) for area/deduct, open
   * polyline for length, one marker per point for count.
   * Markup: note/text = [anchor]; rect/cloud/highlight = [corner, opposite
   * corner]; arrow = [tail, head]; pen = simplified freehand polyline.
   */
  points: Point[];
  color: string;
  /** Category id (see `Category`); missing/undefined = uncategorised (older saves too). */
  category?: string;
  /** Markup only: comment text (note) / label text (text). */
  text?: string;
  /**
   * Markup only: stroke width in screen px at 100% zoom (the viewer draws it
   * at a constant screen size; export treats it as PDF points). Default 2.
   */
  strokeWidth?: number;
  /** Markup 'text' only: font size in page units (scales with the drawing, like CAD text). */
  fontSize?: number;
}

// ---------------------------------------------------------------------------
// Multi-file workspace (contract — implemented in pdfClient / store)
// ---------------------------------------------------------------------------
//
// Several PDFs can be open together. All their pages form ONE continuous list
// of *global* page numbers (1-based): file A pages 1..nA, then file B pages
// nA+1..nA+nB, … Everything that already uses a page number (measurements,
// calibrations, ViewerCanvas, thumbnails, render()) keeps working with the
// global number. Only pdfClient and export need to map global → (doc, local).

export interface WorkspaceDoc {
  /** Stable id for this open file (also used as persistence key part). */
  id: string;
  name: string;
  /** Persistence fingerprint of the file (see state/persistence.ts). */
  fingerprint?: string;
  numPages: number;
  /** Global page number of this doc's first page minus 1. */
  pageOffset: number;
  /** Page sizes for this doc's pages (local order). */
  pageSizes: PageSize[];
}

export interface PageLocation {
  docId: string;
  /** 1-based page number inside that doc. */
  localPage: number;
}

/**
 * Multi-document client. render({page}) takes the GLOBAL page number.
 * `open(file)` (single-file API above) = close all + addFile(file).
 */
export interface WorkspaceClient extends PdfClient {
  addFile(file: File): Promise<WorkspaceDoc>;
  removeDoc(docId: string): Promise<void>;
  docs(): WorkspaceDoc[];
  locate(globalPage: number): PageLocation | null;
  /** Original bytes of an open file (for PDF export with pdf-lib). */
  getFileBytes(docId: string): Promise<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// Markup / annotation kinds (contract)
// ---------------------------------------------------------------------------
//
// Annotations are stored in the same `measurements` array as AreaMeasurement
// objects with one of these kinds, plus optional `text` / `strokeWidth`.
// They are NOT takeoff quantities: summaries, CSV totals and category
// subtotals must ignore them (use `isMarkupKind`).
export type MarkupKind = 'note' | 'text' | 'rect' | 'cloud' | 'arrow' | 'pen' | 'highlight';
