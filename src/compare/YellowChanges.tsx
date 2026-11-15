import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getPdfClient } from '../core/pdfClient';
import type { Rect } from '../core/types';
import { toGray } from '../core/versionDiff';
import { useViewer } from '../state/store';
import { subscribeSettled, type SettledView } from '../components/viewer/commands';
import { useCompare } from './compareStore';
import { yellowInWorker } from './runCompare';

/**
 * Version compare, "yellow" mode: on the NEW version only, its changes in one colour — ink that is
 * new is recoloured yellow, and where something was removed the area gets a yellow highlighter.
 *
 * Inside the transformed world (page units) of the new page: a whole-page overlay (quick) plus a
 * sharp overlay for the settled view. Each is built from the same region of both versions rendered
 * at the same size (the old one mapped through the page-size ratio and the alignment found by the
 * compare), diffed per pixel in the compare worker.
 */

interface Layer {
  rect: Rect;
  canvas: HTMLCanvasElement;
  key: string;
}

const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const FULL_BUDGET = COARSE ? 2_000_000 : 5_000_000;
const SHARP_MAX_PX = COARSE ? 3_000_000 : 7_000_000;
/** Highlighter half-width over removed things, in screen px. */
const MARK_SCREEN_PX = 7;
const fullScale = (w: number, h: number) => Math.min(Math.sqrt(FULL_BUDGET / (w * h)), 8000 / Math.max(w, h));

export const YellowChanges = memo(function YellowChanges({ page }: { page: number }) {
  const doc = useViewer((s) => s.docs.find((d) => page > d.pageOffset && page <= d.pageOffset + d.numPages));
  const size = useViewer((s) => s.pageSizes[page - 1]);
  const c = useCompare(
    useShallow((s) => ({
      on: s.status !== 'idle' && s.visible && s.mode === 'yellow',
      oldId: s.oldId,
      newId: s.newId,
      pairOf: s.pairOf,
      shifts: s.shifts,
      diffed: s.diffed,
    })),
  );
  const local = doc ? page - doc.pageOffset : 0;
  const isNew = !!doc && doc.id === c.newId;
  const oldLocal = isNew ? c.pairOf[doc!.id]?.[local] : undefined;
  const shift = isNew ? c.shifts[local] : undefined;
  // Wait for the compare's alignment of this page (old pages are often shifted a few px).
  const active = c.on && isNew && !!size && oldLocal != null && !!c.diffed[local];
  const key = `${c.oldId}|${oldLocal}|${local}|${shift?.dx ?? 0}|${shift?.dy ?? 0}`;

  const [full, setFull] = useOwnedLayer();
  const [sharp, setSharp] = useOwnedLayer();

  // Whole page.
  useEffect(() => {
    setFull(null);
    setSharp(null);
    if (!active || !size) return;
    let cancelled = false;
    const scale = fullScale(size.width, size.height);
    const rect = { x: 0, y: 0, width: size.width, height: size.height };
    // At the fit zoom the page is about as wide as the screen.
    const fitZoom = Math.min(window.innerWidth / size.width, window.innerHeight / size.height);
    const job = buildYellow({ page, rect, scale, zoom: fitZoom, oldId: c.oldId!, oldLocal: oldLocal!, shift });
    job.promise.then(
      (canvas) => (cancelled ? freeCanvas(canvas) : setFull({ rect, canvas, key })),
      (e: unknown) => !cancelled && (e as { name?: string })?.name !== 'AbortError' && console.warn('compare yellow failed', e),
    );
    return () => {
      cancelled = true;
      job.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, size?.width, size?.height]);

  // Sharp layer for the settled view.
  useEffect(() => {
    if (!active || !size) return;
    let job: ReturnType<typeof buildYellow> | null = null;
    let timer = 0;
    const unsub = subscribeSettled((v: SettledView) => {
      job?.cancel();
      job = null;
      clearTimeout(timer);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let s = v.zoom * dpr;
      if (s <= fullScale(size.width, size.height) * 1.15) {
        setSharp(null);
        useCompare.setState({ sharpening: false });
        return;
      }
      const pad = 0.15;
      const x0 = Math.max(0, v.visible.x - v.visible.width * pad);
      const y0 = Math.max(0, v.visible.y - v.visible.height * pad);
      const x1 = Math.min(size.width, v.visible.x + v.visible.width * (1 + pad));
      const y1 = Math.min(size.height, v.visible.y + v.visible.height * (1 + pad));
      if (x1 <= x0 || y1 <= y0) return;
      const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      const px = rect.width * rect.height * s * s;
      if (px > SHARP_MAX_PX) s *= Math.sqrt(SHARP_MAX_PX / px);
      useCompare.setState({ sharpening: true });
      timer = window.setTimeout(
        () => {
          const my = (job = buildYellow({ page, rect, scale: s, zoom: v.zoom, oldId: c.oldId!, oldLocal: oldLocal!, shift }));
          my.promise.then(
            (canvas) => {
              if (job !== my) return freeCanvas(canvas);
              setSharp({ rect, canvas, key });
              useCompare.setState({ sharpening: false });
            },
            () => {
              if (job === my) useCompare.setState({ sharpening: false });
            },
          );
        },
        COARSE ? 350 : 150,
      );
    });
    return () => {
      unsub();
      clearTimeout(timer);
      job?.cancel();
      setSharp(null);
      useCompare.setState({ sharpening: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, size?.width, size?.height]);

  if (!active || !size) return null;
  return (
    <div className="pointer-events-none absolute left-0 top-0" style={{ width: size.width, height: size.height, zIndex: 12 }} data-testid="compare-yellow">
      {full?.key === key && <CanvasHost layer={full} testId="compare-yellow-full" />}
      {sharp?.key === key && <CanvasHost layer={sharp} testId="compare-yellow-sharp" />}
    </div>
  );
});

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

/** Renders `region` of a global page at `scale` into an outW×outH gray image. */
function renderGray(globalPage: number, region: Rect, scale: number, outW: number, outH: number, isCancelled: () => boolean) {
  const task = getPdfClient().render({ page: globalPage, scale, region, priority: 1 });
  const promise = task.promise.then((res) => {
    try {
      if (isCancelled()) throw abortError();
      const cv = document.createElement('canvas');
      cv.width = outW;
      cv.height = outH;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(res.bitmap, 0, 0, outW, outH);
      const data = ctx.getImageData(0, 0, outW, outH).data;
      cv.width = cv.height = 0;
      return toGray(data, outW, outH);
    } finally {
      res.bitmap.close();
    }
  });
  return { promise, cancel: () => task.cancel() };
}

/**
 * The yellow overlay of `rect` (page units of the new page) at `scale` px per unit. `zoom` (CSS px
 * per unit when shown) keeps the highlighter about the same width on screen.
 */
function buildYellow(o: {
  page: number;
  rect: Rect;
  scale: number;
  zoom: number;
  oldId: string;
  oldLocal: number;
  shift?: { dx: number; dy: number };
}): { promise: Promise<HTMLCanvasElement>; cancel(): void } {
  const v = useViewer.getState();
  const ns = v.pageSizes[o.page - 1];
  const od = v.docs.find((d) => d.id === o.oldId);
  const os = od?.pageSizes[o.oldLocal - 1];
  if (!ns || !od || !os) return { promise: Promise.reject(new Error('gone')), cancel() {} };
  const kx = os.width / ns.width;
  const ky = os.height / ns.height;
  const outW = Math.max(1, Math.round(o.rect.width * o.scale));
  const outH = Math.max(1, Math.round(o.rect.height * o.scale));
  const oldRegion: Rect = {
    x: (o.rect.x / ns.width + (o.shift?.dx ?? 0)) * os.width,
    y: (o.rect.y / ns.height + (o.shift?.dy ?? 0)) * os.height,
    width: o.rect.width * kx,
    height: o.rect.height * ky,
  };
  let cancelled = false;
  const isCancelled = () => cancelled;
  const a = renderGray(o.page, o.rect, o.scale, outW, outH, isCancelled);
  const b = renderGray(od.pageOffset + o.oldLocal, oldRegion, o.scale / Math.max(kx, ky), outW, outH, isCancelled);
  // The page alignment was found at ~1600 px per page: allow ~2 of those px of residual shift here.
  const residual = Math.ceil((Math.max(ns.width, ns.height) / 1600) * 2 * o.scale);
  const promise = Promise.all([a.promise, b.promise]).then(async ([newG, oldG]) => {
    if (cancelled) throw abortError();
    const markRadius = Math.max(2, Math.round((MARK_SCREEN_PX * o.scale) / Math.max(o.zoom, 1e-6) / 2));
    const y = await yellowInWorker(oldG, newG, outW, outH, { maxShift: Math.min(48, residual), markRadius });
    if (cancelled) throw abortError();
    const cv = document.createElement('canvas');
    cv.width = outW;
    cv.height = outH;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('no 2d');
    ctx.putImageData(new ImageData(y.rgba as Uint8ClampedArray<ArrayBuffer>, outW, outH), 0, 0);
    return cv;
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      a.cancel();
      b.cancel();
    },
  };
}

/** Frees a canvas' pixels now (iOS reclaims canvas memory only at GC); deferred until off screen. */
function freeCanvas(cv: HTMLCanvasElement): void {
  cv.dataset.retired = '1';
  setTimeout(() => {
    if (!cv.isConnected) cv.width = cv.height = 0;
  }, 0);
}

/** Layer state that frees the canvas it replaces (and the last one on unmount). */
function useOwnedLayer(): [Layer | null, (l: Layer | null) => void] {
  const [layer, setLayer] = useState<Layer | null>(null);
  const cur = useRef<Layer | null>(null);
  const set = useCallback((l: Layer | null) => {
    const prev = cur.current;
    cur.current = l;
    if (prev && prev.canvas !== l?.canvas) freeCanvas(prev.canvas);
    setLayer(l);
  }, []);
  useEffect(
    () => () => {
      if (cur.current) freeCanvas(cur.current.canvas);
      cur.current = null;
    },
    [],
  );
  return [layer, set];
}

function CanvasHost({ layer, testId }: { layer: Layer; testId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const cv = layer.canvas;
    cv.style.width = '100%';
    cv.style.height = '100%';
    cv.style.display = 'block';
    host.appendChild(cv);
    return () => {
      cv.remove();
      if (cv.dataset.retired) cv.width = cv.height = 0;
    };
  }, [layer]);
  return (
    <div
      ref={ref}
      className="absolute"
      data-testid={testId}
      style={{ left: layer.rect.x, top: layer.rect.y, width: layer.rect.width, height: layer.rect.height }}
    />
  );
}
