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
import type { PdfClient, PdfDocumentInfo, Rect, RenderResult, RenderTask, WorkerRequest, WorkerResponse } from './types';

/** Must match UNSUPPORTED_PREFIX in renderQueue.ts (kept as a literal so renderQueue is only loaded lazily here). */
const UNSUPPORTED_PREFIX = 'PDF_WORKER_UNSUPPORTED:';

type RenderOpts = { page: number; scale: number; region?: Rect; priority?: number };

interface PendingRender {
  id: number;
  opts: RenderOpts;
  resolve(r: RenderResult): void;
  reject(e: Error): void;
}

interface PendingOpen {
  seq: number;
  file: File;
  resolve(info: PdfDocumentInfo): void;
  reject(e: Error): void;
}

function abortError(message = 'Aborted'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

// ---------------------------------------------------------------------------
// Main-thread fallback renderer
// ---------------------------------------------------------------------------

interface MainJob {
  id: number;
  priority: number;
  opts: RenderOpts;
  active: import('./renderQueue').ActiveRender;
  done: PendingRender;
}

class MainThreadRenderer {
  private gen = 0;
  private ready: Promise<{ doc: PDFDocumentProxy; pages: import('./renderQueue').PageCache }> | null = null;
  private destroyDoc: (() => void) | null = null;
  private jobs = new Map<number, MainJob>();
  private schedulerP: Promise<import('./renderQueue').RenderScheduler<MainJob>> | null = null;
  private libP = Promise.all([import('pdfjs-dist'), import('./renderQueue')]).then(([pdfjs, rq]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
    return { pdfjs, rq };
  });

  async open(file: File): Promise<PdfDocumentInfo> {
    this.close();
    const myGen = ++this.gen;
    const { pdfjs, rq } = await this.libP;
    const readyP = (async () => {
      const data = new Uint8Array(await file.arrayBuffer());
      if (myGen !== this.gen) throw abortError();
      const task = pdfjs.getDocument({
        data,
        useWorkerFetch: false,
        CMapReaderFactory: rq.AssetCMapReaderFactory,
        StandardFontDataFactory: rq.AssetStandardFontDataFactory,
        useSystemFonts: false,
        enableXfa: false,
        verbosity: 0,
      } as Parameters<typeof pdfjs.getDocument>[0]);
      this.destroyDoc = () => void task.destroy().catch(() => {});
      let doc: PDFDocumentProxy;
      try {
        doc = await task.promise;
      } catch (e) {
        throw new Error(rq.describeLoadError(e));
      }
      return { doc, pages: new rq.PageCache(doc) };
    })();
    readyP.catch(() => {}); // observed below; avoid unhandled rejection if superseded
    if (myGen !== this.gen) throw abortError();
    this.ready = readyP;
    const { doc } = await readyP;
    const pageSizes = await rq.getAllPageSizes(doc, () => myGen !== this.gen);
    if (myGen !== this.gen) throw abortError();
    return { numPages: doc.numPages, pageSizes };
  }

  render(done: PendingRender): void {
    const job: MainJob = {
      id: done.id,
      priority: done.opts.priority ?? 0,
      opts: done.opts,
      active: { task: null, cancelled: false },
      done,
    };
    this.jobs.set(job.id, job);
    this.scheduler().then((s) => {
      if (!job.active.cancelled) s.enqueue(job);
    });
  }

  cancel(id: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.active.cancelled = true;
    this.jobs.delete(id);
    void this.schedulerP?.then((s) => s.dequeue(id));
    job.active.task?.cancel();
  }

  close(): void {
    this.gen++;
    for (const id of [...this.jobs.keys()]) this.cancel(id);
    this.destroyDoc?.();
    this.destroyDoc = null;
    this.ready?.catch(() => {});
    this.ready = null;
  }

  private scheduler() {
    return (this.schedulerP ??= this.libP.then(({ rq }) => new rq.RenderScheduler<MainJob>((j) => this.run(j))));
  }

  private async run(job: MainJob): Promise<void> {
    const { rq } = await this.libP;
    try {
      if (!this.ready) throw new Error('No document is open');
      const { pages } = await this.ready;
      if (job.active.cancelled) throw rq.makeCancelError();
      const page = await pages.get(job.opts.page);
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
      await rq.renderInto(page, ctx, plan, job.active);
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

class PdfClientImpl implements PdfClient {
  private worker: Worker | null = null;
  private main: MainThreadRenderer | null = null;
  private mode: 'worker' | 'main';
  private nextId = 1;
  private openSeq = 0;
  private pendingOpen: PendingOpen | null = null;
  private renders = new Map<number, PendingRender>();
  private currentFile: File | null = null;
  /** Resolves once the document is open on the main-thread fallback (after a switch). */
  private mainReady: Promise<unknown> | null = null;

  constructor() {
    this.mode = workerRenderingLikelySupported() ? 'worker' : 'main';
  }

  open(file: File): Promise<PdfDocumentInfo> {
    this.closeInternal(false);
    this.currentFile = file;
    const seq = ++this.openSeq;
    return new Promise<PdfDocumentInfo>((resolve, reject) => {
      this.pendingOpen = { seq, file, resolve, reject };
      if (this.mode === 'worker' && this.ensureWorker()) {
        this.send({ type: 'open', file, seq } as WorkerRequest);
      } else {
        this.openOnMain(this.pendingOpen);
      }
    });
  }

  render(opts: RenderOpts): RenderTask {
    const id = this.nextId++;
    let entry!: PendingRender;
    const promise = new Promise<RenderResult>((resolve, reject) => {
      entry = {
        id,
        opts,
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
    this.renders.set(id, entry);
    this.dispatch(entry);
    return {
      promise,
      cancel: () => {
        if (!this.renders.has(id)) return;
        entry.reject(abortError('Render cancelled'));
        if (this.mode === 'worker') this.send({ type: 'cancel', id });
        else this.main?.cancel(id);
      },
    };
  }

  close(): void {
    this.closeInternal(true);
    this.currentFile = null;
  }

  // -------------------------------------------------------------------------

  private closeInternal(sendClose: boolean) {
    if (this.pendingOpen) {
      this.pendingOpen.reject(abortError('Superseded by another open()'));
      this.pendingOpen = null;
    }
    for (const r of [...this.renders.values()]) r.reject(abortError('Document closed'));
    this.renders.clear();
    if (sendClose && this.worker) this.send({ type: 'close' });
    this.main?.close();
    this.mainReady = null;
  }

  private dispatch(entry: PendingRender) {
    const { page, scale, region, priority } = entry.opts;
    if (this.mode === 'worker') {
      if (!this.worker) {
        entry.reject(new Error('No document is open'));
        return;
      }
      this.send({ type: 'render', id: entry.id, page, scale, region, priority: priority ?? 0 });
    } else {
      const main = this.getMain();
      const ready = this.mainReady;
      if (ready) {
        ready.then(
          () => this.renders.has(entry.id) && main.render(entry),
          () => {},
        );
      } else {
        main.render(entry);
      }
    }
  }

  private getMain(): MainThreadRenderer {
    return (this.main ??= new MainThreadRenderer());
  }

  private openOnMain(pending: PendingOpen) {
    const p = this.getMain().open(pending.file);
    this.mainReady = p;
    p.then(
      (info) => {
        if (this.pendingOpen?.seq !== pending.seq) return;
        this.pendingOpen = null;
        pending.resolve(info);
      },
      (e: unknown) => {
        if (this.pendingOpen?.seq !== pending.seq) return;
        this.pendingOpen = null;
        pending.reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  }

  /** Permanently switch to main-thread rendering; re-open the current file there and re-dispatch work. */
  private switchToMain(reason: string) {
    if (this.mode === 'main') return;
    console.warn(`[pdfClient] falling back to main-thread rendering: ${reason}`);
    this.mode = 'main';
    this.worker?.terminate();
    this.worker = null;
    const pendingRenders = [...this.renders.values()];
    if (this.pendingOpen) {
      this.openOnMain(this.pendingOpen);
    } else if (this.currentFile) {
      const p = this.getMain().open(this.currentFile);
      p.catch(() => {});
      this.mainReady = p;
    }
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

  private onWorkerMessage(msg: WorkerResponse & { seq?: number }) {
    switch (msg.type) {
      case 'opened': {
        const p = this.pendingOpen;
        if (!p || (msg.seq !== undefined && msg.seq !== p.seq)) return;
        this.pendingOpen = null;
        p.resolve({ numPages: msg.numPages, pageSizes: msg.pageSizes });
        break;
      }
      case 'error': {
        if (msg.message.startsWith(UNSUPPORTED_PREFIX)) {
          this.switchToMain(msg.message.slice(UNSUPPORTED_PREFIX.length));
          return;
        }
        const p = this.pendingOpen;
        if (!p || (msg.seq !== undefined && msg.seq !== p.seq)) {
          console.error('[pdfClient] worker error:', msg.message);
          return;
        }
        this.pendingOpen = null;
        p.reject(new Error(msg.message));
        break;
      }
      case 'rendered': {
        const r = this.renders.get(msg.id);
        if (!r) {
          msg.bitmap.close(); // cancelled / superseded
          return;
        }
        r.resolve({ bitmap: msg.bitmap, page: msg.page, scale: msg.scale, region: msg.region });
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

export function createPdfClient(): PdfClient {
  return new PdfClientImpl();
}

let singleton: PdfClient | null = null;

export function getPdfClient(): PdfClient {
  return (singleton ??= createPdfClient());
}
