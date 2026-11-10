import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getPdfClient } from '../core/pdfClient';
import type { Rect } from '../core/types';
import { useViewer } from '../state/store';
import { screenToPage, subscribeSettled, type SettledView } from '../components/viewer/commands';
import { useCompare, VERSION_COLOR } from './compareStore';

/**
 * Version compare as in Autodesk Forma's 2D compare: both versions drawn one over the other, the
 * previous one in red and the new one in blue — ink in both versions comes out dark, ink in only
 * one keeps its colour. Each version can be hidden; "colours" off draws both black; the curtain
 * shows the previous version on one side and the new one on the other.
 *
 * Lives inside the transformed world (page units) of the page on screen:
 *  - the page on screen (the viewer's own sharp render) is tinted with its version's colour by a
 *    solid layer in `screen` blend mode (black ink → colour, white paper stays white);
 *  - the other version is rendered into canvases (a whole-page one + a sharp one for the settled
 *    view), tinted the same way, and laid over with `multiply`;
 *  - hiding a version / the curtain = white covers and clip-paths.
 */

type Role = 'old' | 'new';

interface OtherLayer {
  /** Page-unit rect (of the page on screen) the canvas covers. */
  rect: Rect;
  canvas: HTMLCanvasElement;
  key: string;
}

const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** Pixel budget of the whole-page layer (a quick full view while the sharp one renders). */
const FULL_BUDGET = COARSE ? 2_000_000 : 6_000_000;
/** Scale (px per page unit) of the whole-page layer: by area, so long strip drawings stay sharp too. */
const fullScale = (w: number, h: number) => Math.min(Math.sqrt(FULL_BUDGET / (w * h)), 8000 / Math.max(w, h));
/** Pixel budget of the sharp layer. */
const SHARP_MAX_PX = COARSE ? 3_000_000 : 8_000_000;

export const FormaLayers = memo(function FormaLayers({ page }: { page: number }) {
  const doc = useViewer((s) => s.docs.find((d) => page > d.pageOffset && page <= d.pageOffset + d.numPages));
  const size = useViewer((s) => s.pageSizes[page - 1]);
  const c = useCompare(
    useShallow((s) => ({
      on: s.status !== 'idle' && s.visible && s.mode === 'layers',
      oldId: s.oldId,
      newId: s.newId,
      pairOf: s.pairOf,
      shifts: s.shifts,
      layers: s.layers,
      colors: s.colors,
      curtain: s.curtain,
      curtainX: s.curtainX,
    })),
  );
  const local = doc ? page - doc.pageOffset : 0;
  const role: Role | null = doc?.id === c.newId ? 'new' : doc?.id === c.oldId ? 'old' : null;
  const otherRole: Role = role === 'new' ? 'old' : 'new';
  const otherId = role === 'new' ? c.oldId : c.newId;
  const otherLocal = doc ? c.pairOf[doc.id]?.[local] : undefined;
  const newLocal = role === 'new' ? local : otherLocal;
  const shift = newLocal != null ? c.shifts[newLocal] : undefined;
  const active = c.on && !!doc && !!size && !!role && otherLocal != null;

  const [full, setFull] = useOwnedLayer();
  const [sharp, setSharp] = useOwnedLayer();
  const tint = c.colors ? VERSION_COLOR[otherRole] : null;
  const layerKey = `${otherId}|${otherLocal}|${shift?.dx ?? 0}|${shift?.dy ?? 0}|${tint}`;

  // Whole page of the other version (once per page / alignment / colour).
  useEffect(() => {
    setFull(null);
    setSharp(null);
    if (!active || !size) return;
    let cancelled = false;
    const scale = fullScale(size.width, size.height);
    const job = renderOther({ rect: { x: 0, y: 0, width: size.width, height: size.height }, scale, page, otherId: otherId!, otherLocal: otherLocal!, role: role!, shift, tint });
    job.promise.then(
      (canvas) => (cancelled ? freeCanvas(canvas) : setFull({ rect: { x: 0, y: 0, width: size.width, height: size.height }, canvas, key: layerKey })),
      () => {},
    );
    return () => {
      cancelled = true;
      job.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, layerKey, size?.width, size?.height]);

  // Sharp layer for the settled view.
  useEffect(() => {
    if (!active || !size) return;
    let job: ReturnType<typeof renderOther> | null = null;
    let timer = 0;
    const unsub = subscribeSettled((v: SettledView) => {
      job?.cancel();
      clearTimeout(timer);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const scale = v.zoom * dpr;
      // Not needed when the whole-page layer is already sharp enough.
      if (scale <= fullScale(size.width, size.height) * 1.15) {
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
      let rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      let s = scale;
      const px = rect.width * rect.height * s * s;
      if (px > SHARP_MAX_PX) s *= Math.sqrt(SHARP_MAX_PX / px);
      rect = { ...rect };
      useCompare.setState({ sharpening: true });
      // Phones: wait a bit longer — a pinch is often followed by another one.
      timer = window.setTimeout(() => {
        const my = (job = renderOther({ rect, scale: s, page, otherId: otherId!, otherLocal: otherLocal!, role: role!, shift, tint }));
        my.promise.then(
          (canvas) => {
            if (job !== my) return freeCanvas(canvas);
            setSharp({ rect, canvas, key: layerKey });
            if (job === my) useCompare.setState({ sharpening: false });
          },
          () => {},
        );
      }, COARSE ? 350 : 120);
    });
    return () => {
      unsub();
      clearTimeout(timer);
      job?.cancel();
      setSharp(null);
      useCompare.setState({ sharpening: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, layerKey, size?.width, size?.height]);

  if (!active || !size || !role) return null;
  const W = size.width;
  const H = size.height;
  const showSelf = c.layers[role];
  const showOther = c.layers[otherRole];
  // Curtain: the previous version on the right of it, the new one on the left (RTL reading order).
  const cx = c.curtainX * 100;
  const sideOf = (r: Role) => (r === 'old' ? `inset(0 0 0 ${cx}%)` : `inset(0 ${100 - cx}% 0 0)`);
  const otherClip = c.curtain ? sideOf(otherRole) : undefined;

  return (
    // No z-index / opacity / transform on this wrapper: it must not form a stacking context, or the
    // blend modes below would blend with nothing instead of with the page render under it.
    <div className="pointer-events-none absolute left-0 top-0" style={{ width: W, height: H }} data-testid="compare-layers-view" data-role={role}>
      {/* The page on screen in its version's colour. */}
      {/* Drawing's own colours out first (grey), so only the version colours speak. */}
      {c.colors && <div className="absolute inset-0" style={{ background: '#808080', mixBlendMode: 'saturation', zIndex: 11 }} />}
      {c.colors && <div className="absolute inset-0" style={{ background: VERSION_COLOR[role], mixBlendMode: 'screen', zIndex: 11 }} data-testid="compare-tint-self" />}
      {/* This version hidden (fully, or on the other side of the curtain): white over it. */}
      {(!showSelf || c.curtain) && (
        <div
          className="absolute inset-0 bg-white"
          style={{ clipPath: showSelf && c.curtain ? sideOf(otherRole) : undefined, zIndex: 11 }}
          data-testid="compare-hide-self"
        />
      )}
      {/* The other version, multiplied over as ONE group (the sharp canvas covers the whole-page one). */}
      {showOther && (
        <div className="absolute inset-0" style={{ mixBlendMode: 'multiply', clipPath: otherClip, zIndex: 12 }} data-testid="compare-other-group">
          {full?.key === layerKey && <CanvasHost layer={full} testId="compare-other" />}
          {sharp?.key === layerKey && <CanvasHost layer={sharp} testId="compare-other-sharp" />}
        </div>
      )}
      {c.curtain && <CurtainHandle W={W} H={H} />}
    </div>
  );
});

/**
 * Frees a canvas' pixel memory now. iOS reclaims canvas memory only when the element is garbage
 * collected — a new sharp layer on every zoom / pan otherwise piles up hundreds of MB (crash).
 * Deferred one task so the replacement is in the DOM first; skipped if the canvas is shown again.
 */
function freeCanvas(cv: HTMLCanvasElement): void {
  // Still on screen (React has not swapped it out yet) → CanvasHost frees it when it leaves.
  cv.dataset.retired = '1';
  setTimeout(() => {
    if (!cv.isConnected) cv.width = cv.height = 0;
  }, 0);
}

/** Layer state that frees the canvas it replaces (and the last one on unmount). */
function useOwnedLayer(): [OtherLayer | null, (l: OtherLayer | null) => void] {
  const [layer, setLayer] = useState<OtherLayer | null>(null);
  const cur = useRef<OtherLayer | null>(null);
  const set = useCallback((l: OtherLayer | null) => {
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

function CanvasHost({ layer, testId }: { layer: OtherLayer; testId: string }) {
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

/**
 * Renders `rect` (page units of the page on screen) of the other version — mapped through the
 * page-size ratio and the alignment shift — at `scale` px per page unit, tinted with `tint`
 * (null = untinted black ink).
 */
function renderOther(o: {
  rect: Rect;
  scale: number;
  page: number;
  otherId: string;
  otherLocal: number;
  role: Role;
  shift?: { dx: number; dy: number };
  tint: string | null;
}): { promise: Promise<HTMLCanvasElement>; cancel(): void } {
  const v = useViewer.getState();
  const self = v.pageSizes[o.page - 1];
  const other = v.docs.find((d) => d.id === o.otherId);
  const os = other?.pageSizes[o.otherLocal - 1];
  if (!other || !os || !self) return { promise: Promise.reject(new Error('gone')), cancel() {} };
  const kx = os.width / self.width;
  const ky = os.height / self.height;
  // old(x + dx) ≈ new(x), in page fractions.
  const sgn = o.role === 'new' ? 1 : -1;
  const dx = (o.shift?.dx ?? 0) * sgn;
  const dy = (o.shift?.dy ?? 0) * sgn;
  const region: Rect = {
    x: (o.rect.x / self.width + dx) * os.width,
    y: (o.rect.y / self.height + dy) * os.height,
    width: o.rect.width * kx,
    height: o.rect.height * ky,
  };
  const outW = Math.max(1, Math.round(o.rect.width * o.scale));
  const outH = Math.max(1, Math.round(o.rect.height * o.scale));
  const task = getPdfClient().render({ page: other.pageOffset + o.otherLocal, scale: o.scale / Math.max(kx, ky), region, priority: 1 });
  let cancelled = false;
  const promise = task.promise.then((res) => {
    try {
      if (cancelled) throw new Error('cancelled');
      const cv = document.createElement('canvas');
      cv.width = outW;
      cv.height = outH;
      const ctx = cv.getContext('2d');
      if (!ctx) throw new Error('no 2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(res.bitmap, 0, 0, outW, outH);
      if (o.tint) {
        // Grey first (the drawing's own colours out), then black ink → the version's colour.
        ctx.globalCompositeOperation = 'saturation';
        ctx.fillStyle = '#808080';
        ctx.fillRect(0, 0, outW, outH);
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = o.tint;
        ctx.fillRect(0, 0, outW, outH);
      }
      return cv;
    } finally {
      res.bitmap.close();
    }
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      task.cancel();
    },
  };
}

/** Draggable curtain line (page units; the knob stays screen-sized). */
function CurtainHandle({ W, H }: { W: number; H: number }) {
  const x = useCompare((s) => s.curtainX);
  const ref = useRef<HTMLDivElement>(null);
  const [knobY, setKnobY] = useState(H / 2);
  useEffect(() => subscribeSettled((v) => setKnobY(Math.min(H - 1, Math.max(1, v.visible.y + v.visible.height / 2)))), [H]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let id: number | null = null;
    const move = (e: PointerEvent) => {
      const p = screenToPage(e.clientX, e.clientY);
      if (p) useCompare.setState({ curtainX: Math.min(1, Math.max(0, p.x / W)) });
    };
    // Native listeners: the viewer pans on pointerdown at its container, below this element.
    const down = (e: PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      id = e.pointerId;
      el.setPointerCapture(e.pointerId);
      move(e);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      e.stopPropagation();
      move(e);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      e.stopPropagation();
      id = null;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, [W]);
  const s = (n: number) => `calc(${n}px * var(--inv-zoom, 1))`;
  return (
    <div
      ref={ref}
      data-testid="compare-curtain"
      className="absolute top-0"
      style={{ left: x * W, height: H, width: s(36), transform: 'translateX(-50%)', pointerEvents: 'auto', cursor: 'ew-resize', touchAction: 'none', zIndex: 13 }}
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 bg-slate-900" style={{ width: s(2.5), boxShadow: `0 0 ${s(6)} rgba(0,0,0,0.45)` }} />
      <div
        className="absolute left-1/2 flex items-center gap-1 whitespace-nowrap rounded-full bg-slate-900 text-white shadow-lg ring-2 ring-white"
        style={{ top: knobY, height: s(30), transform: 'translate(-50%, -50%)', padding: `0 ${s(10)}`, fontSize: s(11), fontWeight: 700, gap: s(8) }}
        dir="ltr"
      >
        <span style={{ color: '#9ec0ff' }}>◀ חדשה</span>
        <span style={{ color: '#ff9ea3' }}>קודמת ▶</span>
      </div>
    </div>
  );
}
