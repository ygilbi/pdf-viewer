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
  | { type: 'open'; file: File | ArrayBuffer }
  | {
      type: 'render';
      /** Unique id chosen by the client; echoed back in the response. */
      id: number;
      /** 1-based page number. */
      page: number;
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
  | { type: 'close' };

export type WorkerResponse =
  | { type: 'opened'; numPages: number; pageSizes: PageSize[] }
  | { type: 'rendered'; id: number; page: number; bitmap: ImageBitmap; scale: number; region: Rect }
  | { type: 'renderError'; id: number; message: string; cancelled?: boolean }
  | { type: 'error'; message: string };

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

export type ToolId = 'pan' | 'calibrate' | 'area' | 'deduct' | 'length';

/**
 * What a measurement represents:
 *  - 'area'   facade polygon (gross area)
 *  - 'deduct' opening (window/door) polygon subtracted from the area that
 *             contains its centroid on the same page
 *  - 'length' open polyline (≥2 points), measured by total length
 */
export type MeasurementKind = 'area' | 'deduct' | 'length';

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
  kind?: MeasurementKind;
  /** Vertices in page units. Polygon (closed implicitly) for area/deduct, open polyline for length. */
  points: Point[];
  color: string;
}
