/**
 * PdfClient — the only PDF API the UI talks to.
 *
 * Primary path: a module Web Worker (pdfWorker.ts) owns pdf.js and renders
 * into OffscreenCanvas, returning transferable ImageBitmaps.
 *
 * Fallback path (no module workers / no OffscreenCanvas in workers, or the
 * worker reports it cannot render): pdf.js on the main thread (its parser still
 * runs in pdf.js' own worker), rendering to a canvas and producing an
 * ImageBitmap via createImageBitmap(). Same API either way.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { locatePage, withOffsets } from './workspaceMap';
import type {
  PageLocation,
  PdfDocumentInfo,
  Rect,
  RenderResult,
  RenderTask,
  WorkerRequest,
  WorkerResponse,
  WorkspaceClient,
  WorkspaceDoc,
} from './types';

/** Must match UNSUPPORTED_PREFIX in renderQueue.ts (kept as a literal so renderQueue is only loaded lazily here). */
const UNSUPPORTED_PREFIX = 'PDF_WORKER_UNSUPPORTED:';

/** `page` is the GLOBAL (workspace) page number. */
type RenderOpts = { page: number; scale: number; region?: Rect; priority?: number };

interface PendingRender {
  id: number;
  opts: RenderOpts;
  docId: string;
  /** Page number inside `docId`'s document. */
  localPage: number;
  resolve(r: RenderResult): void;
  reject(e: Error): void;
}

interface PendingOpen {
  seq: number;
  docId: string;
  file: File;
  resolve(info: PdfDocumentInfo): void;
  reject(e: Error): void;
}

function abortError(message = 'Aborted'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

export { globalPageOf, locatePage, withOffsets } from './workspaceMap';

// ---------------------------------------------------------------------------
// Main-thread fallback renderer (several documents, keyed by docId)
// ---------------------------------------------------------------------------

interface MainJob {
  id: number;
  priority: number;
  docId: string;
  localPage: number;
  opts: RenderOpts;
  active: import('./renderQueue').ActiveRender;
  done: PendingRender;
}

interface MainDoc {
  closed: boolean;
  ready: Promise<{ doc: PDFDocumentProxy; pages: import('./renderQueue').PageCache }>;
  destroy: (() => void) | null;
}

class MainThreadRenderer {
  private docs = new Map<string, MainDoc>();
  private jobs = new Map<number, MainJob>();
  private schedulerP: Promise<import('./renderQueue').RenderScheduler<MainJob>> | null = null;
  private libP = Promise.all([import('pdfjs-dist'), import('./renderQueue')]).then(([pdfjs, rq]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
    // Resume the most urgent render slice first (same as the worker).
    const ch = new MessageChannel();
    const slices = new rq.PriorityYield(() => ch.port2.postMessage(0));
    ch.port1.onmessage = () => slices.runNext();
    return { pdfjs, rq, slices };
  });

  async open(docId: string, file: File): Promise<PdfDocumentInfo> {
    this.close(docId);
    const state: MainDoc = { closed: false, ready: null!, destroy: null };
    state.ready = (async () => {
      const { pdfjs, rq } = await this.libP;
      const data = new Uint8Array(await file.arrayBuffer());
      if (state.closed) throw abortError();
      const task = pdfjs.getDocument({
        data,
        useWorkerFetch: false,
        CMapReaderFactory: rq.AssetCMapReaderFactory,
        StandardFontDataFactory: rq.AssetStandardFontDataFactory,
        useSystemFonts: false,
        enableXfa: false,
        verbosity: 0,
      } as Parameters<typeof pdfjs.getDocument>[0]);
      state.destroy = () => void task.destroy().catch(() => {});
      let doc: PDFDocumentProxy;
      try {
        doc = await task.promise;
      } catch (e) {
        throw new Error(rq.describeLoadError(e));
      }
      return { doc, pages: new rq.PageCache(doc) };
    })();
    state.ready.catch(() => {}); // observed below / by renders
    this.docs.set(docId, state);
    const { rq } = await this.libP;
    const { doc } = await state.ready;
    const pageSizes = await rq.getAllPageSizes(doc, () => state.closed);
    if (state.closed) throw abortError();
    return { numPages: doc.numPages, pageSizes };
  }

  render(done: PendingRender): void {
    const d = this.docs.get(done.docId);
    if (!d) {
      done.reject(new Error('No document is open'));
      return;
    }
    const job: MainJob = {
      id: done.id,
      priority: done.opts.priority ?? 0,
      docId: done.docId,
      localPage: done.localPage,
      opts: done.opts,
      active: { task: null, cancelled: false },
      done,
    };
    this.jobs.set(job.id, job);
    // Only queue once the document is parsed (a loading doc must not hold a render slot).
    Promise.all([d.ready, this.scheduler()]).then(
      ([, s]) => {
        if (!job.active.cancelled && this.jobs.has(job.id)) s.enqueue(job);
      },
      (e: unknown) => {
        this.jobs.delete(job.id);
        job.done.reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  }

  cancel(id: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.active.cancelled = true;
    this.jobs.delete(id);
    void this.schedulerP?.then((s) => s.dequeue(id));
    job.active.task?.cancel();
  }

  setPriority(id: number, priority: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.priority = priority;
    void this.schedulerP?.then((s) => s.reprioritize());
  }

  close(docId: string): void {
    const d = this.docs.get(docId);
    if (!d) return;
    this.docs.delete(docId);
    d.closed = true;
    for (const [id, j] of [...this.jobs]) if (j.docId === docId) this.cancel(id);
    d.destroy?.();
  }

  closeAll(): void {
    for (const id of [...this.docs.keys()]) this.close(id);
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  private scheduler() {
    return (this.schedulerP ??= this.libP.then(({ rq }) => new rq.RenderScheduler<MainJob>((j) => this.run(j))));
  }

  private async run(job: MainJob): Promise<void> {
    const { rq, slices } = await this.libP;
    try {
      const d = this.docs.get(job.docId);
      if (!d) throw rq.makeCancelError();
      const { pages } = await d.ready;
      if (job.active.cancelled || d.closed) throw rq.makeCancelError();
      const page = await pages.get(job.localPage);
      const vp = page.getViewport({ scale: 1 });
      const plan = rq.planRender(vp.width, vp.height, job.opts.scale, job.opts.region);
      let canvas: OffscreenCanvas | HTMLCanvasElement;
      if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(plan.width, plan.height);
      } else {
        canvas = document.createElement('canvas');
        canvas.width = plan.width;
        canvas.height = plan.height;
      }
      const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null;
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      await rq.renderInto(page, ctx, plan, job.active, slices.forJob(() => job.priority));
      if (job.active.cancelled) throw rq.makeCancelError();
      const bitmap = await createImageBitmap(canvas);
      canvas.width = canvas.height = 0;
      if (job.active.cancelled) {
        bitmap.close();
        throw rq.makeCancelError();
      }
      job.done.resolve({ bitmap, page: job.opts.page, scale: plan.scale, region: plan.region });
    } catch (e) {
      job.done.reject(rq.isCancelError(e) ? abortError('Render cancelled') : e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.jobs.delete(job.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function workerRenderingLikelySupported(): boolean {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
}

interface DocEntry {
  doc: WorkspaceDoc;
  /** Kept as-is (no copy) for getFileBytes() and a main-thread re-open. */
  file: File;
}

class PdfClientImpl implements WorkspaceClient {
  private worker: Worker | null = null;
  private main: MainThreadRenderer | null = null;
  private mode: 'worker' | 'main';
  private nextId = 1;
  private openSeq = 0;
  private docSeq = 0;
  /** Bumped by closeAll() so an addFile() that resolves afterwards is dropped. */
  private epoch = 0;
  private pendingOpens = new Map<string, PendingOpen>();
  private renders = new Map<number, PendingRender>();
  /** Ready documents, in workspace order. */
  private entries: DocEntry[] = [];

  constructor() {
    this.mode = workerRenderingLikelySupported() ? 'worker' : 'main';
  }

  /**
   * Boot the render worker (and inside it pdf.js + its parser worker) ahead
   * of the first open(), so their start-up overlaps with the user choosing a
   * file instead of delaying the first pixels.
   */
  prewarm(): void {
    if (this.mode === 'worker') this.ensureWorker();
  }

  // ---- workspace API ------------------------------------------------------

  async open(file: File): Promise<PdfDocumentInfo> {
    this.closeAll();
    const doc = await this.addFile(file);
    return { numPages: doc.numPages, pageSizes: doc.pageSizes };
  }

  async addFile(file: File): Promise<WorkspaceDoc> {
    const docId = `doc${++this.docSeq}`;
    const epoch = this.epoch;
    const info = await this.openRaw(docId, file);
    if (epoch !== this.epoch) {
      if (this.worker) this.send({ type: 'close', docId });
      this.main?.close(docId);
      throw abortError('Superseded by another open()');
    }
    const pageOffset = this.entries.reduce((n, e) => n + e.doc.numPages, 0);
    const doc: WorkspaceDoc = { id: docId, name: file.name, numPages: info.numPages, pageOffset, pageSizes: info.pageSizes };
    this.entries.push({ doc, file });
    return doc;
  }

  async removeDoc(docId: string): Promise<void> {
    const pending = this.pendingOpens.get(docId);
    if (pending) {
      this.pendingOpens.delete(docId);
      pending.reject(abortError('Document removed'));
    }
    const i = this.entries.findIndex((e) => e.doc.id === docId);
    if (i >= 0) {
      // Renders of this doc and of every later doc carry stale global page numbers.
      const affected = new Set(this.entries.slice(i).map((e) => e.doc.id));
      for (const r of [...this.renders.values()]) if (affected.has(r.docId)) this.cancelRender(r);
      this.entries.splice(i, 1);
      const docs = withOffsets(this.entries.map((e) => e.doc));
      this.entries = this.entries.map((e, k) => ({ ...e, doc: docs[k] }));
    }
    if (this.worker) this.send({ type: 'close', docId });
    this.main?.close(docId);
  }

  docs(): WorkspaceDoc[] {
    return this.entries.map((e) => e.doc);
  }

  locate(globalPage: number): PageLocation | null {
    return locatePage(this.docs(), globalPage);
  }

  getFileBytes(docId: string): Promise<ArrayBuffer> {
    const e = this.entries.find((x) => x.doc.id === docId);
    if (!e) return Promise.reject(new Error(`Unknown document: ${docId}`));
    return e.file.arrayBuffer();
  }

  render(opts: RenderOpts): RenderTask {
    const id = this.nextId++;
    const loc = this.locate(opts.page);
    let entry!: PendingRender;
    const promise = new Promise<RenderResult>((resolve, reject) => {
      entry = {
        id,
        opts,
        docId: loc?.docId ?? '',
        localPage: loc?.localPage ?? 0,
        resolve: (r) => {
          this.renders.delete(id);
          resolve(r);
        },
        reject: (e) => {
          this.renders.delete(id);
          reject(e);
        },
      };
    });
    if (!loc) {
      entry.reject(new Error(this.entries.length ? `Page ${opts.page} is out of range` : 'No document is open'));
      return { promise, cancel: () => {}, setPriority: () => {} };
    }
    this.renders.set(id, entry);
    this.dispatch(entry);
    return {
      promise,
      cancel: () => this.cancelRender(entry),
      setPriority: (priority: number) => {
        if (!this.renders.has(id)) return;
        entry.opts = { ...entry.opts, priority };
        if (this.mode === 'worker') this.send({ type: 'priority', id, priority });
        else this.main?.setPriority(id, priority);
      },
    };
  }

  close(): void {
    this.closeAll();
  }

  // -------------------------------------------------------------------------

  private cancelRender(entry: PendingRender) {
    if (!this.renders.has(entry.id)) return;
    entry.reject(abortError('Render cancelled'));
    if (this.mode === 'worker') this.send({ type: 'cancel', id: entry.id });
    else this.main?.cancel(entry.id);
  }

  private closeAll() {
    this.epoch++;
    for (const p of [...this.pendingOpens.values()]) p.reject(abortError('Superseded by another open()'));
    this.pendingOpens.clear();
    for (const r of [...this.renders.values()]) r.reject(abortError('Document closed'));
    this.renders.clear();
    this.entries = [];
    if (this.worker) this.send({ type: 'close' });
    this.main?.closeAll();
  }

  private openRaw(docId: string, file: File): Promise<PdfDocumentInfo> {
    const seq = ++this.openSeq;
    return new Promise<PdfDocumentInfo>((resolve, reject) => {
      const pending: PendingOpen = { seq, docId, file, resolve, reject };
      this.pendingOpens.set(docId, pending);
      if (this.mode === 'worker' && this.ensureWorker()) {
        this.send({ type: 'open', file, docId, seq } as WorkerRequest);
      } else {
        this.openOnMain(pending);
      }
    });
  }

  private dispatch(entry: PendingRender) {
    const { scale, region, priority } = entry.opts;
    if (this.mode === 'worker') {
      if (!this.worker) {
        entry.reject(new Error('No document is open'));
        return;
      }
      this.send({ type: 'render', id: entry.id, docId: entry.docId, page: entry.localPage, scale, region, priority: priority ?? 0 });
    } else {
      this.getMain().render(entry);
    }
  }

  private getMain(): MainThreadRenderer {
    return (this.main ??= new MainThreadRenderer());
  }

  private settleOpen(pending: PendingOpen): boolean {
    if (this.pendingOpens.get(pending.docId)?.seq !== pending.seq) return false;
    this.pendingOpens.delete(pending.docId);
    return true;
  }

  private openOnMain(pending: PendingOpen) {
    this.getMain()
      .open(pending.docId, pending.file)
      .then(
        (info) => this.settleOpen(pending) && pending.resolve(info),
        (e: unknown) => this.settleOpen(pending) && pending.reject(e instanceof Error ? e : new Error(String(e))),
      );
  }

  /** Permanently switch to main-thread rendering; re-open every file there and re-dispatch work. */
  private switchToMain(reason: string) {
    if (this.mode === 'main') return;
    console.warn(`[pdfClient] falling back to main-thread rendering: ${reason}`);
    this.mode = 'main';
    this.worker?.terminate();
    this.worker = null;
    const pendingRenders = [...this.renders.values()];
    for (const e of this.entries) this.getMain().open(e.doc.id, e.file).catch(() => {});
    for (const p of [...this.pendingOpens.values()]) this.openOnMain(p);
    for (const r of pendingRenders) this.dispatch(r);
  }

  private ensureWorker(): boolean {
    if (this.worker) return true;
    try {
      const w = new Worker(new URL('./pdfWorker.ts', import.meta.url), { type: 'module', name: 'pdf-render' });
      w.onmessage = (ev: MessageEvent<WorkerResponse & { seq?: number }>) => this.onWorkerMessage(ev.data);
      w.onerror = (ev) => {
        ev.preventDefault?.();
        this.switchToMain(`worker error: ${ev.message || 'failed to load'}`);
      };
      w.onmessageerror = () => this.switchToMain('worker message could not be deserialized');
      this.worker = w;
      return true;
    } catch (e) {
      this.mode = 'main';
      console.warn('[pdfClient] module worker unavailable, using main thread:', e);
      return false;
    }
  }

  private send(msg: WorkerRequest) {
    this.worker?.postMessage(msg);
  }

  private pendingFor(msg: { docId?: string; seq?: number }): PendingOpen | null {
    const p = msg.docId ? this.pendingOpens.get(msg.docId) : undefined;
    if (!p || (msg.seq !== undefined && msg.seq !== p.seq)) return null;
    return p;
  }

  private onWorkerMessage(msg: WorkerResponse & { seq?: number }) {
    switch (msg.type) {
      case 'opened': {
        const p = this.pendingFor(msg);
        if (!p) return;
        this.pendingOpens.delete(p.docId);
        try {
          performance.mark('viewer:opened');
        } catch {
          /* ignore */
        }
        p.resolve({ numPages: msg.numPages, pageSizes: msg.pageSizes });
        break;
      }
      case 'error': {
        if (msg.message.startsWith(UNSUPPORTED_PREFIX)) {
          this.switchToMain(msg.message.slice(UNSUPPORTED_PREFIX.length));
          return;
        }
        const p = this.pendingFor(msg);
        if (!p) {
          console.error('[pdfClient] worker error:', msg.message);
          return;
        }
        this.pendingOpens.delete(p.docId);
        p.reject(new Error(msg.message));
        break;
      }
      case 'rendered': {
        const r = this.renders.get(msg.id);
        if (!r) {
          msg.bitmap.close(); // cancelled / superseded
          return;
        }
        r.resolve({ bitmap: msg.bitmap, page: r.opts.page, scale: msg.scale, region: msg.region });
        break;
      }
      case 'renderError': {
        const r = this.renders.get(msg.id);
        if (!r) return;
        if (msg.message.startsWith(UNSUPPORTED_PREFIX)) {
          this.switchToMain(msg.message.slice(UNSUPPORTED_PREFIX.length));
          return;
        }
        r.reject(msg.cancelled ? abortError('Render cancelled') : new Error(msg.message));
        break;
      }
    }
  }
}

export function createPdfClient(): WorkspaceClient {
  return new PdfClientImpl();
}

let singleton: WorkspaceClient | null = null;

/** The app-wide client (implements both the single-file PdfClient and the multi-file WorkspaceClient API). */
export function getPdfClient(): WorkspaceClient {
  if (!singleton) {
    singleton = createPdfClient();
    if (typeof window !== 'undefined' && /[?&]bench\b/.test(window.location.search)) {
      (window as unknown as { __pdfClient?: WorkspaceClient }).__pdfClient = singleton; // benchmark hook
    }
  }
  return singleton;
}

/** Same object as getPdfClient(), typed for workspace (multi-file) use. */
export const getWorkspaceClient = getPdfClient;

// Pre-warm the worker shortly after app start (browser only; not in tests).
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !import.meta.env?.VITEST) {
  const warm = () => (getPdfClient() as PdfClientImpl).prewarm();
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(warm, { timeout: 1000 });
  else setTimeout(warm, 200);
}
