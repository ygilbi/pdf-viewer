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

/** LRU of PDFPageProxy; evicted pages get `cleanup()` to free operator lists / resources. */
export class PageCache {
  private pages = new Map<number, Promise<PDFPageProxy>>();

  constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly max = PAGE_CACHE_SIZE,
  ) {}

  get(pageNumber: number): Promise<PDFPageProxy> {
    let p = this.pages.get(pageNumber);
    if (p) {
      this.pages.delete(pageNumber);
      this.pages.set(pageNumber, p);
      return p;
    }
    p = this.doc.getPage(pageNumber);
    p.catch(() => this.pages.delete(pageNumber));
    this.pages.set(pageNumber, p);
    while (this.pages.size > this.max) {
      const [oldNum, oldPage] = this.pages.entries().next().value as [number, Promise<PDFPageProxy>];
      this.pages.delete(oldNum);
      // cleanup() is a no-op (returns false) while renders are pending on the page.
      oldPage.then((pg) => pg.cleanup()).catch(() => {});
    }
    return p;
  }

  clear(): void {
    this.pages.clear();
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
