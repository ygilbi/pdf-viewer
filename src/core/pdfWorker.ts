/// <reference lib="webworker" />
/**
 * Module Web Worker that owns the pdf.js documents (several, keyed by docId) and renders pages/regions
 * into OffscreenCanvas, returning transferable ImageBitmaps.
 *
 * Loaded via:
 *   new Worker(new URL('./pdfWorker.ts', import.meta.url), { type: 'module' })
 *
 * Protocol: WorkerRequest / WorkerResponse in ./types.ts. Additionally, `open`
 * may carry a numeric `seq` which is echoed back on the matching `opened` /
 * `error` response so the client can drop responses for superseded opens.
 */
import { GlobalWorkerOptions, PDFWorker, getDocument } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Rect, WorkerRequest, WorkerResponse } from './types';
import type { TextItem, TextWorkerRequest, TextWorkerResponse } from './types';
import { toTextItems } from '../text/textGeometry';
import { AnnotationMode, OPS } from 'pdfjs-dist';
import type { SnapWorkerRequest, SnapWorkerResponse } from './types';
import { snapPointsFromOperatorList, type SnapOps } from './vectorSnap';
import {
  PageCache,
  PriorityYield,
  RenderScheduler,
  UNSUPPORTED_PREFIX,
  describeLoadError,
  getAllPageSizes,
  isCancelError,
  makeCancelError,
  planRender,
  renderInto,
  type ActiveRender,
  AssetCMapReaderFactory,
  AssetStandardFontDataFactory,
} from './renderQueue';

declare const self: DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// DOM-free factories for pdf.js display layer
// ---------------------------------------------------------------------------

class OffscreenCanvasFactory {
  constructor(_opts: unknown) {}
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset(cc: { canvas: OffscreenCanvas | null }, width: number, height: number) {
    if (!cc.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    cc.canvas.width = width;
    cc.canvas.height = height;
  }
  destroy(cc: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (!cc.canvas) throw new Error('Canvas is not specified');
    cc.canvas.width = 0;
    cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
}

/** SVG filters (transfer functions / HCM) need DOM; no-op them (same as pdf.js' Node fallback). */
class NoopFilterFactory {
  constructor(_opts: unknown) {}
  addFilter() {
    return 'none';
  }
  addHCMFilter() {
    return 'none';
  }
  addAlphaFilter() {
    return 'none';
  }
  addLuminosityFilter() {
    return 'none';
  }
  addHighlightHCMFilter() {
    return 'none';
  }
  destroy() {}
}

// Fonts: Chromium/Firefox/Safari expose a FontFaceSet on workers (`self.fonts`);
// pdf.js only needs `ownerDocument.fonts` for FontFace loading. When present we
// use real FontFace (fast, hinted/anti-aliased glyphs); otherwise glyphs are
// drawn as paths (disableFontFace) which is always correct, just slower.
const workerFonts = (self as unknown as { fonts?: FontFaceSet }).fonts;
const fontFaceSupported = !!workerFonts && typeof FontFace !== 'undefined';
const fakeOwnerDocument = { fonts: workerFonts };

// ---------------------------------------------------------------------------
// pdf.js parser worker (nested). Dedicated workers can spawn workers in all
// modern browsers; if not, pdf.js falls back to parsing in this thread
// ("fake worker" via dynamic import of workerSrc), which is fine — we are
// already off the main thread.
// ---------------------------------------------------------------------------

GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
// ONE long-lived PDFWorker shared by all documents, passed explicitly to
// getDocument(). pdf.js only destroys workers it created itself, so closing a
// document never tears down the parser that the next document uses. (Setting
// GlobalWorkerOptions.workerPort instead makes loadingTask.destroy() destroy
// the cached port worker → the next open fails with "PDFWorker.fromPort - the
// worker is being destroyed".)
let parserWorker: PDFWorker | null = null;
function getParserWorker(): PDFWorker | undefined {
  if (parserWorker && !parserWorker.destroyed) return parserWorker;
  parserWorker = null;
  if (typeof Worker === 'undefined') return undefined; // pdf.js creates a per-document fake worker
  try {
    parserWorker = new PDFWorker({
      port: new Worker(pdfjsWorkerUrl, { type: 'module', name: 'pdfjs-parser' }),
      verbosity: 0,
    } as unknown as ConstructorParameters<typeof PDFWorker>[0]);
  } catch {
    parserWorker = null;
  }
  return parserWorker ?? undefined;
}

function canRenderHere(): string | null {
  if (typeof OffscreenCanvas === 'undefined') return 'OffscreenCanvas is not available in workers';
  try {
    const c = new OffscreenCanvas(1, 1);
    const ctx = c.getContext('2d');
    if (!ctx) return 'OffscreenCanvas 2D context is not available';
    if (typeof c.transferToImageBitmap !== 'function') return 'transferToImageBitmap is not available';
  } catch (e) {
    return `OffscreenCanvas failed: ${String(e)}`;
  }
  return null;
}
const unsupportedReason = canRenderHere();
// Start pdf.js' parser worker now (the client pre-warms this worker before the first open).
if (!unsupportedReason) getParserWorker();

// ---------------------------------------------------------------------------
// Document state (several documents, keyed by docId)
// ---------------------------------------------------------------------------

const DEFAULT_DOC = 'default';

interface DocState {
  docId: string;
  closed: boolean;
  loadingTask: PDFDocumentLoadingTask | null;
  ready: Promise<{ doc: PDFDocumentProxy; pages: PageCache; sizes: { width: number; height: number }[] }>;
}

const docs = new Map<string, DocState>();

function post(msg: WorkerResponse & { seq?: number }, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function closeDoc(docId: string) {
  const d = docs.get(docId);
  if (!d) return;
  docs.delete(docId);
  d.closed = true;
  cancelWhere((j) => j.doc === d);
  d.ready.catch(() => {});
  d.loadingTask?.destroy().catch(() => {});
}

function closeAll() {
  for (const id of [...docs.keys()]) closeDoc(id);
  cancelWhere(() => true);
}

function openDoc(file: File | ArrayBuffer, docId: string, seq: number | undefined) {
  closeDoc(docId); // re-open under the same id replaces it
  if (unsupportedReason) {
    post({ type: 'error', message: UNSUPPORTED_PREFIX + unsupportedReason, docId, seq });
    return;
  }
  const state: DocState = { docId, closed: false, loadingTask: null, ready: null! };
  state.ready = (async () => {
    let data: Uint8Array;
    try {
      // Read the File here so the main thread never copies the bytes.
      data = new Uint8Array(file instanceof ArrayBuffer ? file : await file.arrayBuffer());
    } catch (e) {
      throw new Error(`Could not read file: ${String(e)}`);
    }
    if (state.closed) throw makeCancelError();
    const loadingTask = getDocument({
      data,
      worker: getParserWorker(),
      isOffscreenCanvasSupported: true,
      isEvalSupported: true,
      disableFontFace: !fontFaceSupported,
      useSystemFonts: false,
      useWorkerFetch: false,
      ownerDocument: fakeOwnerDocument as unknown as Document,
      CanvasFactory: OffscreenCanvasFactory,
      FilterFactory: NoopFilterFactory,
      CMapReaderFactory: AssetCMapReaderFactory,
      StandardFontDataFactory: AssetStandardFontDataFactory,
      cMapPacked: true,
      enableXfa: false,
      verbosity: 0,
    } as Parameters<typeof getDocument>[0]);
    state.loadingTask = loadingTask;
    let doc: PDFDocumentProxy;
    try {
      doc = await loadingTask.promise;
    } catch (e) {
      throw new Error(describeLoadError(e));
    }
    const sizes = await getAllPageSizes(doc, () => state.closed);
    return { doc, pages: new PageCache(doc), sizes };
  })();
  docs.set(docId, state);

  state.ready.then(
    ({ doc, sizes }) => {
      if (!state.closed) post({ type: 'opened', numPages: doc.numPages, pageSizes: sizes, docId, seq });
    },
    (e: unknown) => {
      if (state.closed) return;
      post({ type: 'error', message: e instanceof Error ? e.message : String(e), docId, seq });
      closeDoc(docId);
    },
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface Job {
  id: number;
  priority: number;
  page: number;
  scale: number;
  region?: Rect;
  doc: DocState;
  active: ActiveRender;
}

const jobs = new Map<number, Job>();

// Yield to the event loop between pdf.js render slices so `cancel` messages
// (and higher-priority requests) are processed mid-render, and resume the most
// urgent render first (see PriorityYield). MessageChannel is not clamped like
// nested setTimeout.
const yieldChannel = new MessageChannel();
const slices = new PriorityYield(() => yieldChannel.port2.postMessage(0));
yieldChannel.port1.onmessage = () => slices.runNext();

const scheduler = new RenderScheduler<Job>(runJob);

async function runJob(job: Job): Promise<void> {
  // Released in `finally` on EVERY path. A render cancelled mid-way (every pinch/zoom step cancels
  // the previous one) used to keep its OffscreenCanvas alive until GC — on iOS canvas memory is
  // only reclaimed then, so quick zooming piled up hundreds of MB and Safari killed the tab.
  let canvas: OffscreenCanvas | null = null;
  try {
    if (job.active.cancelled) throw makeCancelError();
    const { pages } = await job.doc.ready;
    if (job.active.cancelled || job.doc.closed) throw makeCancelError();
    const page = await pages.get(job.page);
    if (job.active.cancelled) throw makeCancelError();
    const vp = page.getViewport({ scale: 1 });
    const plan = planRender(vp.width, vp.height, job.scale, job.region);
    canvas = new OffscreenCanvas(plan.width, plan.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error(UNSUPPORTED_PREFIX + 'OffscreenCanvas 2D context is not available');
    await renderInto(page, ctx, plan, job.active, slices.forJob(() => job.priority));
    if (job.active.cancelled) throw makeCancelError();
    const bitmap = canvas.transferToImageBitmap();
    post({ type: 'rendered', id: job.id, page: job.page, bitmap, scale: plan.scale, region: plan.region }, [bitmap]);
  } catch (e) {
    const cancelled = job.active.cancelled || isCancelError(e);
    post({
      type: 'renderError',
      id: job.id,
      message: cancelled ? 'Render cancelled' : e instanceof Error ? e.message : String(e),
      cancelled: cancelled || undefined,
    });
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
    jobs.delete(job.id);
  }
}

function cancelJob(id: number) {
  const job = jobs.get(id);
  if (!job) return;
  job.active.cancelled = true;
  if (scheduler.dequeue(id)) {
    jobs.delete(id);
    post({ type: 'renderError', id, message: 'Render cancelled', cancelled: true });
    return;
  }
  job.active.task?.cancel();
}

function cancelWhere(pred: (job: Job) => boolean) {
  for (const [id, job] of [...jobs]) if (pred(job)) cancelJob(id);
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

self.onmessage = (ev: MessageEvent<WorkerRequest & { seq?: number }>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'open':
      openDoc(msg.file, msg.docId ?? DEFAULT_DOC, msg.seq);
      break;
    case 'render': {
      const doc = docs.get(msg.docId ?? DEFAULT_DOC);
      if (!doc) {
        post({ type: 'renderError', id: msg.id, message: 'No document is open' });
        return;
      }
      const job: Job = {
        id: msg.id,
        priority: msg.priority ?? 0,
        page: msg.page,
        scale: msg.scale,
        region: msg.region,
        doc,
        active: { task: null, cancelled: false },
      };
      jobs.set(job.id, job);
      scheduler.enqueue(job);
      break;
    }
    case 'cancel':
      cancelJob(msg.id);
      break;
    case 'priority': {
      const job = jobs.get(msg.id);
      if (job) {
        job.priority = msg.priority;
        scheduler.reprioritize();
      }
      break;
    }
    case 'close':
      if (msg.docId) closeDoc(msg.docId);
      else closeAll();
      break;
  }
};

// ---------------------------------------------------------------------------
// Page text ('text' request) — own listener so the render protocol stays untouched.
// Items are converted to page units (rotated viewport at scale 1) and cached
// per document + page; the cache goes away with the DocState.
// ---------------------------------------------------------------------------

const textCache = new WeakMap<DocState, Map<number, Promise<TextItem[]>>>();

function pageText(d: DocState, pageNumber: number): Promise<TextItem[]> {
  let m = textCache.get(d);
  if (!m) textCache.set(d, (m = new Map()));
  let p = m.get(pageNumber);
  if (!p) {
    p = (async () => {
      const { doc } = await d.ready;
      if (d.closed) throw makeCancelError();
      // doc.getPage (not PageCache): a 40-page search must not evict the pages being rendered.
      const page = await doc.getPage(pageNumber);
      const vt = page.getViewport({ scale: 1 }).transform;
      const tc = await page.getTextContent();
      return toTextItems(vt, tc.items);
    })();
    const cache = m;
    p.catch(() => cache.delete(pageNumber));
    m.set(pageNumber, p);
  }
  return p;
}

self.addEventListener('message', (ev: MessageEvent<TextWorkerRequest | { type?: unknown }>) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'text') return;
  const { id, page, docId } = msg as TextWorkerRequest;
  const reply = (r: TextWorkerResponse) => self.postMessage(r);
  const d = docs.get(docId ?? DEFAULT_DOC);
  if (!d) {
    reply({ type: 'textError', id, message: 'No document is open' });
    return;
  }
  pageText(d, page).then(
    (items) => reply({ type: 'text', id, items }),
    (e: unknown) => reply({ type: 'textError', id, message: e instanceof Error ? e.message : String(e) }),
  );
});

// ---------------------------------------------------------------------------
// Vector snap geometry ('snapGeometry' request) — own listener, like 'text'.
// Line segments of painted paths → endpoints / midpoints / intersections in
// page units (core/vectorSnap.ts). Cached per document + page (the cache
// goes away with the DocState); results are copied per reply (transferable).
// ---------------------------------------------------------------------------

type SnapResult = Omit<Extract<SnapWorkerResponse, { type: 'snapGeometry' }>, 'type' | 'id'>;
const snapCache = new WeakMap<DocState, Map<number, Promise<SnapResult>>>();

function pageSnapGeometry(d: DocState, pageNumber: number): Promise<SnapResult> {
  let m = snapCache.get(d);
  if (!m) snapCache.set(d, (m = new Map()));
  let p = m.get(pageNumber);
  if (!p) {
    p = (async () => {
      const t0 = performance.now();
      const { doc } = await d.ready;
      if (d.closed) throw makeCancelError();
      const page = await doc.getPage(pageNumber);
      const vt = page.getViewport({ scale: 1 }).transform;
      // Same annotation mode as rendering (annotations are not drawn).
      const opList = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
      if (d.closed) throw makeCancelError();
      const r = snapPointsFromOperatorList(opList, OPS as unknown as SnapOps, vt);
      return { ...r, ms: performance.now() - t0, extractMs: r.ms };
    })();
    const cache = m;
    p.catch(() => cache.delete(pageNumber));
    m.set(pageNumber, p);
  }
  return p;
}

self.addEventListener('message', (ev: MessageEvent<SnapWorkerRequest | { type?: unknown }>) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'snapGeometry') return;
  const { id, page, docId } = msg as SnapWorkerRequest;
  const reply = (r: SnapWorkerResponse, transfer: Transferable[] = []) => self.postMessage(r, transfer);
  const d = docs.get(docId ?? DEFAULT_DOC);
  if (!d) {
    reply({ type: 'snapGeometryError', id, message: 'No document is open' });
    return;
  }
  pageSnapGeometry(d, page).then(
    (r) => {
      const xy = r.xy.slice();
      const kind = r.kind.slice();
      reply({ type: 'snapGeometry', id, ...r, xy, kind }, [xy.buffer, kind.buffer]);
    },
    (e: unknown) => reply({ type: 'snapGeometryError', id, message: e instanceof Error ? e.message : String(e) }),
  );
});
