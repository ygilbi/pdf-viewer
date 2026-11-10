/**
 * Rendering core shared by the off-main-thread worker (pdfWorker.ts) and the
 * main-thread fallback (pdfClient.ts).
 *
 * This module must stay free of *runtime* pdf.js imports (type imports only),
 * so importing it from the main thread does not pull pdf.js into the main
 * bundle.
 */
import type { PDFDocumentProxy, PDFPageProxy, RenderTask as PdfJsRenderTask } from 'pdfjs-dist';
import type { Rect } from './types';
import { trackTransform } from './ctxTransform';

/** Prefix of an `error` message meaning "this environment cannot render here, use the fallback". */
export const UNSUPPORTED_PREFIX = 'PDF_WORKER_UNSUPPORTED:';

/** Canvas limits (Chromium/Safari safe). */
export const MAX_CANVAS_SIDE = 4096;
export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

export const RENDER_CONCURRENCY = 2;
export const PAGE_CACHE_SIZE = 20;

// ---------------------------------------------------------------------------
// Static assets (CMaps + standard fonts) — resolved by Vite at build time so
// they work in dev and in `vite build` output without copying to public/.
// ---------------------------------------------------------------------------

// Each asset is inlined as a base64 data URI inside its own lazily-loaded JS
// chunk. Only plain .js files are emitted, so the build can be hosted on any
// static host (some refuse unknown binary types like .bcmap/.pfb), and an
// asset is downloaded only when a PDF actually needs it.
type Loader = () => Promise<string>;
const cmapLoaders = basenameMap(
  import.meta.glob('../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
    query: '?inline',
    import: 'default',
  }) as Record<string, Loader>,
);
const standardFontLoaders = basenameMap(
  import.meta.glob(['../../node_modules/pdfjs-dist/standard_fonts/*.pfb', '../../node_modules/pdfjs-dist/standard_fonts/*.ttf'], {
    query: '?inline',
    import: 'default',
  }) as Record<string, Loader>,
);

function basenameMap(m: Record<string, Loader>): Map<string, Loader> {
  const out = new Map<string, Loader>();
  for (const [k, v] of Object.entries(m)) out.set(k.slice(k.lastIndexOf('/') + 1), v);
  return out;
}

async function loadBytes(load: Loader): Promise<Uint8Array> {
  const dataUri = await load();
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class AssetCMapReaderFactory {
  constructor(_opts: unknown) {}
  async fetch({ name }: { name: string }) {
    const load = cmapLoaders.get(`${name}.bcmap`);
    if (!load) throw new Error(`Unknown CMap: ${name}`);
    return { cMapData: await loadBytes(load), isCompressed: true };
  }
}

export class AssetStandardFontDataFactory {
  constructor(_opts: unknown) {}
  async fetch({ filename }: { filename: string }) {
    const load = standardFontLoaders.get(filename);
    if (!load) throw new Error(`Unknown standard font: ${filename}`);
    return loadBytes(load);
  }
}

// ---------------------------------------------------------------------------
// Priority scheduler
// ---------------------------------------------------------------------------

export interface SchedulerJob {
  id: number;
  priority: number;
}

/**
 * Priority queue with limited concurrency. Highest priority first; among equal
 * priorities the most recently enqueued wins (LIFO), which is what an
 * interactive viewer wants (the latest viewport matters most).
 *
 * A job with a higher priority than everything running may start even when
 * all `concurrency` slots are busy (up to `concurrency + PREEMPT_SLOTS`), so a
 * viewport render never waits for background renders (prefetch, thumbnails)
 * to finish. Running jobs are interleaved by priority at their yield points
 * (see PriorityYield), so the low-priority ones effectively pause.
 */
export class RenderScheduler<J extends SchedulerJob> {
  private queue: { job: J; seq: number }[] = [];
  private running = new Map<number, J>();
  private seq = 0;

  constructor(
    private readonly runJob: (job: J) => Promise<void>,
    private readonly concurrency = RENDER_CONCURRENCY,
  ) {}

  enqueue(job: J): void {
    this.queue.push({ job, seq: this.seq++ });
    this.pump();
  }

  /** Removes a queued job. Returns it if it was still queued (not started). */
  dequeue(id: number): J | undefined {
    const i = this.queue.findIndex((e) => e.job.id === id);
    if (i < 0) return undefined;
    return this.queue.splice(i, 1)[0].job;
  }

  isRunning(id: number): boolean {
    return this.running.has(id);
  }

  /** Removes and returns every queued (not running) job. */
  drain(): J[] {
    const jobs = this.queue.map((e) => e.job);
    this.queue = [];
    return jobs;
  }

  /** Re-evaluate after a job's priority changed. */
  reprioritize(): void {
    this.pump();
  }

  private bestIndex(): number {
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i];
      const b = this.queue[best];
      if (a.job.priority > b.job.priority || (a.job.priority === b.job.priority && a.seq > b.seq)) best = i;
    }
    return best;
  }

  private canStart(job: J): boolean {
    if (this.running.size < this.concurrency) return true;
    if (this.running.size >= this.concurrency + PREEMPT_SLOTS) return false;
    for (const r of this.running.values()) if (r.priority >= job.priority) return false;
    return true;
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const i = this.bestIndex();
      const job = this.queue[i].job;
      if (!this.canStart(job)) return;
      this.queue.splice(i, 1);
      this.running.set(job.id, job);
      this.runJob(job)
        .catch(() => {})
        .finally(() => {
          this.running.delete(job.id);
          this.pump();
        });
    }
  }
}

/** Extra slots a higher-priority job may use while background jobs occupy the normal ones. */
export const PREEMPT_SLOTS = 2;

/**
 * Cooperative scheduling of pdf.js render slices. pdf.js renders in ~15 ms
 * slices and calls `onContinue(cont)` between them; this queue resumes the
 * highest-priority waiting slice first, so a viewport render runs at full speed
 * while lower-priority renders in the same thread wait (they resume whenever
 * the urgent render is idle, e.g. waiting for its operator list). `post`
 * schedules a macrotask (MessageChannel in the worker — not clamped like
 * nested setTimeout).
 */
export class PriorityYield {
  private waiting: { prio: () => number; cont: () => void; seq: number }[] = [];
  private seq = 0;

  constructor(private readonly post: () => void) {}

  /** Returns an `onContinue` for a render whose priority is read lazily (it may change). */
  forJob(prio: () => number): (cont: () => void) => void {
    return (cont) => {
      this.waiting.push({ prio, cont, seq: this.seq++ });
      this.post();
    };
  }

  /** Call once per `post()`. Runs the most urgent waiting slice (FIFO among equals). */
  runNext(): void {
    if (this.waiting.length === 0) return;
    let best = 0;
    for (let i = 1; i < this.waiting.length; i++) {
      const a = this.waiting[i];
      const b = this.waiting[best];
      const pa = a.prio();
      const pb = b.prio();
      if (pa > pb || (pa === pb && a.seq < b.seq)) best = i;
    }
    this.waiting.splice(best, 1)[0].cont();
  }
}

// ---------------------------------------------------------------------------
// Page LRU
// ---------------------------------------------------------------------------

/**
 * Upper bound for the operators of all pages whose operator lists stay cached (PageCache). A parsed
 * operator list costs ~140 B/op of JS heap in the render worker; normal documents never get near
 * this (typical pages have 1k–100k ops), but a few heavy pages (e.g. a 1.75M-op CAD strip ≈ 250 MB)
 * would otherwise all stay resident.
 */
export const MAX_CACHED_OPS = 3_000_000;

type IntentStateLike = { operatorList?: { fnArray: unknown[]; lastChunk: boolean }; renderTasks?: Set<unknown> };
type PageInternals = {
  _intentStates?: Map<string, IntentStateLike>;
  _transport?: { getRenderingIntent?: (intent: string, annotationMode: number) => { cacheKey: string } };
};

/** pdf.js' cached, COMPLETE operator list of `page` for our render intent (display, annotations disabled), if any. */
function displayOpList(page: PDFPageProxy): IntentStateLike['operatorList'] | undefined {
  try {
    const p = page as unknown as PageInternals;
    const key = p._transport?.getRenderingIntent?.('display', 0 /* AnnotationMode.DISABLE */)?.cacheKey;
    const list = key !== undefined ? p._intentStates?.get(key)?.operatorList : undefined;
    return list?.lastChunk && Array.isArray(list.fnArray) ? list : undefined;
  } catch {
    return undefined; // pdf.js internals changed: callers fall back to the public API
  }
}

/** Operator count of the page's rendered operator list (undefined until a render has built it). */
export function displayOpCount(page: PDFPageProxy): number | undefined {
  return displayOpList(page)?.fnArray.length;
}

/**
 * The page's operator list for geometry extraction (snapping) WITHOUT keeping a second copy:
 * `getOperatorList()` uses pdf.js' "oplist" intent, which is cached separately from the list the
 * renders use — on a heavy page that is another ~250 MB. Reuses the render's list when it is
 * complete; otherwise builds one and drops pdf.js' cached copy afterwards (callers cache the result).
 */
export async function operatorListForGeometry(page: PDFPageProxy): Promise<{ fnArray: number[]; argsArray: unknown[] }> {
  const cached = displayOpList(page);
  if (cached) return cached as unknown as { fnArray: number[]; argsArray: unknown[] };
  const list = await page.getOperatorList({ annotationMode: 0 /* AnnotationMode.DISABLE (same as rendering) */ });
  try {
    const states = (page as unknown as PageInternals)._intentStates;
    for (const [key, st] of states ?? []) {
      if (st.operatorList === (list as unknown) && !st.renderTasks?.size) states!.delete(key);
    }
  } catch {
    /* keep pdf.js' copy */
  }
  return list;
}

/**
 * LRU of PDFPageProxy; evicted pages get `cleanup()` to free operator lists / resources. Besides
 * the page count, the total size of the cached operator lists is bounded (MAX_CACHED_OPS; sizes
 * reported via noteOps after a render), so a document with several heavy pages keeps only the
 * most recent one(s) parsed.
 */
export class PageCache {
  private pages = new Map<number, Promise<PDFPageProxy>>();
  private ops = new Map<number, number>();
  /** Pages loaded only by transient renders (version compare) — freed when those finish. */
  private transientOnly = new Set<number>();
  /** Transient renders in flight per page. */
  private transientBusy = new Map<number, number>();

  constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly max = PAGE_CACHE_SIZE,
    private readonly maxOps = MAX_CACHED_OPS,
  ) {}

  get(pageNumber: number, transient = false): Promise<PDFPageProxy> {
    if (transient) {
      this.transientBusy.set(pageNumber, (this.transientBusy.get(pageNumber) ?? 0) + 1);
      if (!this.pages.has(pageNumber)) this.transientOnly.add(pageNumber);
    } else this.transientOnly.delete(pageNumber); // the viewer uses it: keep it
    let p = this.pages.get(pageNumber);
    if (p) {
      this.pages.delete(pageNumber);
      this.pages.set(pageNumber, p);
      return p;
    }
    p = this.doc.getPage(pageNumber);
    p.catch(() => this.pages.delete(pageNumber));
    this.pages.set(pageNumber, p);
    this.trim();
    return p;
  }

  /** Record the operator count of a page's (now cached) operator list; may evict older pages. */
  noteOps(pageNumber: number, ops: number): void {
    if (!this.pages.has(pageNumber)) return;
    this.ops.set(pageNumber, ops);
    this.trim();
  }

  /**
   * A transient render of `pageNumber` finished: when no viewer render touched the page meanwhile,
   * drop it and free its parsed operator list (a heavy page's list is hundreds of MB; a version
   * compare must not leave the other file's pages resident next to the one on screen).
   */
  releaseTransient(pageNumber: number): void {
    const n = (this.transientBusy.get(pageNumber) ?? 1) - 1;
    if (n > 0) {
      this.transientBusy.set(pageNumber, n);
      return;
    }
    this.transientBusy.delete(pageNumber);
    if (!this.transientOnly.delete(pageNumber)) return;
    const p = this.pages.get(pageNumber);
    this.pages.delete(pageNumber);
    this.ops.delete(pageNumber);
    p?.then((pg) => pg.cleanup()).catch(() => {});
  }

  clear(): void {
    this.pages.clear();
    this.ops.clear();
  }

  private totalOps(): number {
    let n = 0;
    for (const v of this.ops.values()) n += v;
    return n;
  }

  private trim(): void {
    // Never evict the most recently used page (the one being rendered).
    while (this.pages.size > 1 && (this.pages.size > this.max || this.totalOps() > this.maxOps)) {
      const [oldNum, oldPage] = this.pages.entries().next().value as [number, Promise<PDFPageProxy>];
      this.pages.delete(oldNum);
      this.ops.delete(oldNum);
      // cleanup() is a no-op (returns false) while renders are pending on the page.
      oldPage.then((pg) => pg.cleanup()).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Render geometry
// ---------------------------------------------------------------------------

export interface RenderPlan {
  /** Effective scale after clamping to canvas limits. */
  scale: number;
  region: Rect;
  width: number;
  height: number;
}

/** Computes output canvas size, reducing the scale if the canvas would exceed limits. */
export function planRender(pageWidth: number, pageHeight: number, scale: number, region?: Rect): RenderPlan {
  const r: Rect = region
    ? { x: region.x, y: region.y, width: region.width, height: region.height }
    : { x: 0, y: 0, width: pageWidth, height: pageHeight };
  if (!(r.width > 0) || !(r.height > 0) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) {
    throw new Error('Invalid render region');
  }
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('Invalid render scale');
  let s = scale;
  const w0 = r.width * s;
  const h0 = r.height * s;
  const f = Math.min(1, MAX_CANVAS_SIDE / w0, MAX_CANVAS_SIDE / h0, Math.sqrt(MAX_CANVAS_PIXELS / (w0 * h0)));
  s *= f;
  const width = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(r.width * s)));
  const height = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.round(r.height * s)));
  return { scale: s, region: r, width, height };
}

export interface ActiveRender {
  task: PdfJsRenderTask | null;
  cancelled: boolean;
}

/**
 * Renders `plan` of `page` into a 2D context sized plan.width x plan.height.
 * `active` lets the caller cancel mid-render.
 */
export async function renderInto(
  page: PDFPageProxy,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  plan: RenderPlan,
  active: ActiveRender,
  yieldFn?: (cont: () => void) => void,
): Promise<void> {
  const viewport = page.getViewport({
    scale: plan.scale,
    offsetX: -plan.region.x * plan.scale,
    offsetY: -plan.region.y * plan.scale,
  });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.width, plan.height);
  if (active.cancelled) throw makeCancelError();
  // getTransform() without a native DOMMatrix per path (see ctxTransform.ts). Fresh context per render.
  trackTransform(ctx);
  const task = page.render({
    canvasContext: ctx as CanvasRenderingContext2D,
    viewport,
    background: '#ffffff',
    // Annotations (form widgets etc.) are not needed for drawings and need DOM.
    annotationMode: 0 /* AnnotationMode.DISABLE */,
  });
  if (yieldFn) task.onContinue = yieldFn;
  active.task = task;
  try {
    await task.promise;
  } finally {
    active.task = null;
  }
}

export function makeCancelError(): Error {
  const e = new Error('Render cancelled');
  e.name = 'AbortError';
  return e;
}

export function isCancelError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'RenderingCancelledException';
}

/** Maps pdf.js load errors to user-facing messages. */
export function describeLoadError(e: unknown): string {
  const err = e as { name?: string; message?: string; code?: number } | null;
  const name = err?.name ?? '';
  const msg = err?.message ?? String(e);
  if (name === 'PasswordException') {
    return err?.code === 2
      ? 'Incorrect password for this PDF.'
      : 'This PDF is password-protected. Password-protected files are not supported.';
  }
  if (name === 'InvalidPDFException') return 'The file is not a valid PDF or is corrupted.';
  if (name === 'MissingPDFException') return 'The PDF file is missing or empty.';
  if (name === 'UnexpectedResponseException') return `Could not load the PDF: ${msg}`;
  return msg ? `Could not open PDF: ${msg}` : 'Could not open PDF.';
}

/** Fetches all page sizes (scale 1, rotation applied): page 1 first, then the rest in parallel batches. */
export async function getAllPageSizes(
  doc: PDFDocumentProxy,
  isStale: () => boolean,
  batch = 64,
): Promise<{ width: number; height: number }[]> {
  const n = doc.numPages;
  const sizes = new Array<{ width: number; height: number }>(n);
  const sizeOf = (p: PDFPageProxy) => {
    const v = p.getViewport({ scale: 1 });
    return { width: v.width, height: v.height };
  };
  if (n === 0) return [];
  sizes[0] = sizeOf(await doc.getPage(1));
  for (let start = 2; start <= n; start += batch) {
    if (isStale()) throw makeCancelError();
    const end = Math.min(n, start + batch - 1);
    const jobs: Promise<void>[] = [];
    for (let i = start; i <= end; i++) {
      jobs.push(
        doc.getPage(i).then(
          (p) => {
            sizes[i - 1] = sizeOf(p);
          },
          () => {
            // A broken page should not prevent opening the document.
            sizes[i - 1] = sizes[0];
          },
        ),
      );
    }
    await Promise.all(jobs);
  }
  return sizes;
}
