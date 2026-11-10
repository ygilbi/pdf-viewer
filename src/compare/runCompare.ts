/**
 * Runs a version compare of two open files: renders each page pair at the
 * same pixel size through the shared PDF client, converts to gray and diffs
 * them in a worker (core/versionDiff). Pages are done one at a time (low
 * memory on phones); results stream into the compare store.
 */
import { getPdfClient } from '../core/pdfClient';
import { diffImageSize, diffPages, pairPages, toGray, type DiffRegion, type PageDiff } from '../core/versionDiff';
import { useViewer } from '../state/store';
import { useCompare, initialCompare } from './compareStore';

const FULL_PAGE: DiffRegion = { x: 0, y: 0, width: 1, height: 1 };
/** Render priority: below the visible page's tiles, so the viewer stays responsive. */
const PRIORITY = 0;

let worker: Worker | null = null;
let workerFailed = false;
let seq = 0;
const pending = new Map<number, { resolve(d: PageDiff): void; reject(e: Error): void }>();

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./diffWorker.ts', import.meta.url), { type: 'module', name: 'version-diff' });
    worker.onmessage = (e: MessageEvent<{ id: number; diff?: PageDiff; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.diff) p.resolve(e.data.diff);
      else p.reject(new Error(e.data.error ?? 'diff failed'));
    };
    worker.onerror = () => {
      workerFailed = true;
      worker?.terminate();
      worker = null;
      for (const [, p] of pending) p.reject(new Error('worker'));
      pending.clear();
    };
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

async function diff(oldG: Uint8Array, newG: Uint8Array, w: number, h: number): Promise<PageDiff> {
  const wk = getWorker();
  if (wk) {
    try {
      return await new Promise<PageDiff>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        const a = oldG.slice().buffer;
        const b = newG.slice().buffer;
        wk.postMessage({ id, oldG: a, newG: b, w, h }, [a, b]);
      });
    } catch {
      /* fall through to the main thread */
    }
  }
  return diffPages(oldG, newG, w, h);
}

/** Renders a global page stretched to w×h and returns its gray pixels. */
async function grayPage(globalPage: number, pageW: number, pageH: number, w: number, h: number, alive: () => boolean): Promise<Uint8Array> {
  const scale = Math.max(w / pageW, h / pageH);
  const task = getPdfClient().render({ page: globalPage, scale, priority: PRIORITY });
  const res = await task.promise;
  try {
    if (!alive()) throw abort();
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(res.bitmap, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    canvas.width = canvas.height = 0;
    return toGray(data, w, h);
  } finally {
    res.bitmap.close();
  }
}

const abort = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

/** Compares `oldId` (previous version) with `newId` (current version). */
export async function runCompare(oldId: string, newId: string): Promise<void> {
  const runId = useCompare.getState().runId + 1;
  const docs = () => useViewer.getState().docs;
  const find = (id: string) => docs().find((d) => d.id === id);
  const o0 = find(oldId);
  const n0 = find(newId);
  if (!o0 || !n0 || oldId === newId) return;
  const { both, added, removed } = pairPages(o0.numPages, n0.numPages);
  useCompare.setState({
    ...initialCompare,
    dialogOpen: false,
    runId,
    status: 'running',
    oldId,
    newId,
    progress: { done: 0, total: both },
    regions: {
      [oldId]: Object.fromEntries(removed.map((p) => [p, [FULL_PAGE]])),
      [newId]: Object.fromEntries(added.map((p) => [p, [FULL_PAGE]])),
    },
    notes: {
      [oldId]: Object.fromEntries(removed.map((p) => [p, 'removed' as const])),
      [newId]: Object.fromEntries(added.map((p) => [p, 'added' as const])),
    },
  });
  const alive = () => useCompare.getState().runId === runId && !!find(oldId) && !!find(newId);
  try {
    for (let p = 1; p <= both; p++) {
      if (!alive()) return;
      const o = find(oldId)!;
      const n = find(newId)!;
      const ns = n.pageSizes[p - 1];
      const os = o.pageSizes[p - 1];
      const { w, h } = diffImageSize(ns.width, ns.height);
      const newG = await grayPage(n.pageOffset + p, ns.width, ns.height, w, h, alive);
      if (!alive()) return;
      const oldG = await grayPage(o.pageOffset + p, os.width, os.height, w, h, alive);
      if (!alive()) return;
      const d = await diff(oldG, newG, w, h);
      if (!alive()) return;
      useCompare.setState((s) => ({
        progress: { done: p, total: both },
        regions: d.regions.length
          ? {
              ...s.regions,
              [newId]: { ...s.regions[newId], [p]: d.regions },
              // The same places on the old version (its pixels map back by the alignment shift).
              [oldId]: { ...s.regions[oldId], [p]: d.regions.map((r) => ({ ...r, x: r.x + d.shift.dx / w, y: r.y + d.shift.dy / h })) },
            }
          : s.regions,
      }));
    }
    if (alive()) useCompare.setState({ status: 'done' });
  } catch (e) {
    if (!alive() || (e as { name?: string })?.name === 'AbortError') return;
    useCompare.setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

/** Global pages (in the given file) that have changes, ascending. */
export function changedGlobalPages(docId: string): number[] {
  const d = useViewer.getState().docs.find((x) => x.id === docId);
  const r = useCompare.getState().regions[docId];
  if (!d || !r) return [];
  return Object.entries(r)
    .filter(([, v]) => v.length)
    .map(([p]) => d.pageOffset + Number(p))
    .sort((a, b) => a - b);
}
