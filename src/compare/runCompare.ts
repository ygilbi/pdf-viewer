/**
 * Runs a version compare of two open files: matches pages (in order; when the
 * page counts differ, by content, so an inserted / deleted sheet does not shift
 * every later one), renders each pair at the same pixel size through the shared
 * PDF client, converts to gray and diffs them in a worker (core/versionDiff).
 * Pages are done one at a time (low memory on phones); results stream into the
 * compare store. The colour overlay of the page on screen is built on demand.
 */
import { getPdfClient } from '../core/pdfClient';
import { diffImageSize, diffPages, fingerprint, matchPages, toGray, type DiffRegion, type PageDiff, type PagePairing } from '../core/versionDiff';
import type { WorkspaceDoc } from '../core/types';
import { useViewer } from '../state/store';
import { useCompare, initialCompare } from './compareStore';

const FULL_PAGE: DiffRegion = { x: 0, y: 0, width: 1, height: 1 };
/** Render priority: below the visible page's tiles, so the viewer stays responsive. */
const PRIORITY = 0;
/** Long side (px) of the page-matching fingerprints' render. */
const MATCH_PX = 160;

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

async function diff(oldG: Uint8Array, newG: Uint8Array, w: number, h: number, withOverlay = false): Promise<PageDiff> {
  const wk = getWorker();
  if (wk) {
    try {
      return await new Promise<PageDiff>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        const a = oldG.slice().buffer;
        const b = newG.slice().buffer;
        wk.postMessage({ id, oldG: a, newG: b, w, h, withOverlay }, [a, b]);
      });
    } catch {
      /* fall through to the main thread */
    }
  }
  return diffPages(oldG, newG, w, h, { withOverlay });
}

const abort = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

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

/** Gray images of a pair at the new page's diff size. */
async function grayPair(o: WorkspaceDoc, n: WorkspaceDoc, oldLocal: number, newLocal: number, alive: () => boolean) {
  const ns = n.pageSizes[newLocal - 1];
  const os = o.pageSizes[oldLocal - 1];
  const { w, h } = diffImageSize(ns.width, ns.height);
  const newG = await grayPage(n.pageOffset + newLocal, ns.width, ns.height, w, h, alive);
  if (!alive()) throw abort();
  const oldG = await grayPage(o.pageOffset + oldLocal, os.width, os.height, w, h, alive);
  return { oldG, newG, w, h };
}

/** Page pairs: in order when the page counts match, else by content (inserted / deleted sheets). */
async function pairPagesOf(o: WorkspaceDoc, n: WorkspaceDoc, alive: () => boolean, onProgress: (done: number, total: number) => void): Promise<PagePairing> {
  if (o.numPages === n.numPages) {
    return { pairs: Array.from({ length: n.numPages }, (_, i) => [i + 1, i + 1] as [number, number]), added: [], removed: [] };
  }
  const total = o.numPages + n.numPages;
  let done = 0;
  const fps = async (d: WorkspaceDoc) => {
    const out: Uint8Array[] = [];
    for (let p = 1; p <= d.numPages; p++) {
      if (!alive()) throw abort();
      const s = d.pageSizes[p - 1];
      const { w, h } = diffImageSize(s.width, s.height, MATCH_PX);
      out.push(fingerprint(await grayPage(d.pageOffset + p, s.width, s.height, w, h, alive), w, h));
      onProgress(++done, total);
    }
    return out;
  };
  const oldFp = await fps(o);
  const newFp = await fps(n);
  return matchPages(oldFp, newFp);
}

/** Compares `oldId` (previous version) with `newId` (current version). */
export async function runCompare(oldId: string, newId: string): Promise<void> {
  const runId = useCompare.getState().runId + 1;
  const docs = () => useViewer.getState().docs;
  const find = (id: string) => docs().find((d) => d.id === id);
  const o0 = find(oldId);
  const n0 = find(newId);
  if (!o0 || !n0 || oldId === newId) return;
  useCompare.setState({
    ...initialCompare,
    dialogOpen: false,
    runId,
    status: 'running',
    phase: o0.numPages === n0.numPages ? 'diff' : 'match',
    oldId,
    newId,
  });
  // Show the new version (adding the old file as a tab may have switched to it).
  const vs = useViewer.getState();
  if (!(vs.currentPage > n0.pageOffset && vs.currentPage <= n0.pageOffset + n0.numPages)) vs.setPage(n0.pageOffset + 1);
  const alive = () => useCompare.getState().runId === runId && !!find(oldId) && !!find(newId);
  try {
    const { pairs, added, removed } = await pairPagesOf(o0, n0, alive, (done, total) => {
      if (alive()) useCompare.setState({ progress: { done, total } });
    });
    if (!alive()) return;
    useCompare.setState({
      phase: 'diff',
      progress: { done: 0, total: pairs.length },
      regions: {
        [oldId]: Object.fromEntries(removed.map((p) => [p, [FULL_PAGE]])),
        [newId]: Object.fromEntries(added.map((p) => [p, [FULL_PAGE]])),
      },
      notes: {
        [oldId]: Object.fromEntries(removed.map((p) => [p, 'removed' as const])),
        [newId]: Object.fromEntries(added.map((p) => [p, 'added' as const])),
      },
      pairOf: {
        [oldId]: Object.fromEntries(pairs.map(([a, b]) => [a, b])),
        [newId]: Object.fromEntries(pairs.map(([a, b]) => [b, a])),
      },
    });
    let i = 0;
    for (const [op, np] of pairs) {
      if (!alive()) return;
      const { oldG, newG, w, h } = await grayPair(find(oldId)!, find(newId)!, op, np, alive);
      if (!alive()) return;
      const d = await diff(oldG, newG, w, h);
      if (!alive()) return;
      i++;
      useCompare.setState((s) => ({
        progress: { done: i, total: pairs.length },
        diffed: { ...s.diffed, [np]: true },
        regions: d.regions.length
          ? {
              ...s.regions,
              [newId]: { ...s.regions[newId], [np]: d.regions },
              // The same places on the old version (its pixels map back by the alignment shift).
              [oldId]: { ...s.regions[oldId], [op]: d.regions.map((r) => ({ ...r, x: r.x + d.shift.dx / w, y: r.y + d.shift.dy / h })) },
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

let overlaySeq = 0;

/**
 * Builds the colour overlay (both versions' ink: common / added / removed) for
 * the pair of `docId`'s local page. Keeps only the latest one (memory).
 */
export async function loadOverlay(docId: string, local: number): Promise<void> {
  const s = useCompare.getState();
  if (!s.oldId || !s.newId) return;
  const newLocal = docId === s.newId ? local : s.pairOf[s.oldId]?.[local];
  const oldLocal = newLocal != null ? s.pairOf[s.newId]?.[newLocal] : undefined;
  if (newLocal == null || oldLocal == null) {
    useCompare.setState({ overlay: null, overlayLoading: false });
    return;
  }
  if (s.overlay?.newLocal === newLocal) return;
  const my = ++overlaySeq;
  const runId = s.runId;
  const alive = () => my === overlaySeq && useCompare.getState().runId === runId;
  useCompare.setState({ overlayLoading: true });
  try {
    const docs = useViewer.getState().docs;
    const o = docs.find((d) => d.id === s.oldId);
    const n = docs.find((d) => d.id === s.newId);
    if (!o || !n) return;
    const { oldG, newG, w, h } = await grayPair(o, n, oldLocal, newLocal, alive);
    if (!alive()) return;
    const d = await diff(oldG, newG, w, h, true);
    if (!alive() || !d.overlay) return;
    useCompare.setState({ overlay: { newLocal, w, h, classes: d.overlay }, overlayLoading: false });
  } catch (e) {
    if (alive()) {
      useCompare.setState({ overlayLoading: false });
      if ((e as { name?: string })?.name !== 'AbortError') console.warn('compare overlay failed', e);
    }
  }
}

/** Global pages (in the given file) that have shown changes, ascending. */
export function changedGlobalPages(docId: string): number[] {
  const d = useViewer.getState().docs.find((x) => x.id === docId);
  const s = useCompare.getState();
  const r = s.regions[docId];
  if (!d || !r) return [];
  const note = s.notes[docId] ?? {};
  return Object.entries(r)
    .filter(([p, v]) => v.some((x) => s.filter[note[Number(p)] ?? x.kind ?? 'modified']))
    .map(([p]) => d.pageOffset + Number(p))
    .sort((a, b) => a - b);
}
