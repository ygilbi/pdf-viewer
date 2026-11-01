import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useViewer } from '../state/store';
import { getPdfClient } from '../core/pdfClient';
import type { PageSize } from '../core/types';
import { IconPanel } from './ui/icons';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const THUMB_MAX_W = 140;
const THUMB_MAX_H = 200;
const ITEM_PAD = 8; // vertical padding inside a slot (top)
const LABEL_H = 20; // page-number row under each thumb
const OVERSCAN_PX = 400;
/** A thumb must stay visible this long before its render is requested (fast-scroll filter). */
const REQUEST_DELAY_MS = 120;
const CACHE_LIMIT = 60;

// ---------------------------------------------------------------------------
// LRU cache of rendered thumbnails (module-level so it survives collapse).
// ---------------------------------------------------------------------------
let cacheDoc: PageSize[] | null = null;
let docSeq = 0;
/** Cached thumbs are small, already-downsampled canvases (cheap to keep ~60). */
type Thumbnail = OffscreenCanvas | HTMLCanvasElement;
const cache = new Map<number, Thumbnail>();

function cacheReset(doc: PageSize[]): number {
  if (cacheDoc === doc) return docSeq;
  cacheDoc = doc;
  docSeq++;
  cache.clear();
  return docSeq;
}
function cacheGet(page: number): Thumbnail | undefined {
  const b = cache.get(page);
  if (b) {
    cache.delete(page);
    cache.set(page, b); // bump recency
  }
  return b;
}
function cachePut(page: number, bitmap: Thumbnail) {
  cache.delete(page);
  cache.set(page, bitmap);
  while (cache.size > CACHE_LIMIT) {
    const k = cache.keys().next().value as number;
    cache.delete(k);
  }
}

/**
 * Thumbnails are rendered SUPERSAMPLE× larger than displayed and then
 * box-filtered down. pdf.js strokes hairlines at ≥1 device px, so dense CAD
 * drawings rendered directly at ~0.1 scale come out solid black; rendering
 * bigger and averaging gives a faithful grey preview. Render time is dominated
 * by vector work, not pixel count, so this costs little.
 */
const SUPERSAMPLE = 4;
const MAX_RENDER_PX = 1400;

function makeCanvas(w: number, h: number): Thumbnail {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Downsample by repeated halving (good-quality box filter), then to exact size. */
function downsample(src: ImageBitmap, w: number, h: number): Thumbnail {
  let cur: CanvasImageSource = src;
  let cw = src.width;
  let ch = src.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const nw = Math.max(1, Math.round(cw / 2));
    const nh = Math.max(1, Math.round(ch / 2));
    const c = makeCanvas(nw, nh);
    const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    cur = c;
    cw = nw;
    ch = nh;
  }
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

/** Dev-only counter used by e2e checks to verify lazy rendering. */
function countRender() {
  if (import.meta.env.DEV) {
    const w = window as unknown as { __thumbRenderCount?: number };
    w.__thumbRenderCount = (w.__thumbRenderCount ?? 0) + 1;
  }
}

function thumbSize(size: PageSize | undefined): { w: number; h: number } {
  if (!size || size.width <= 0 || size.height <= 0) return { w: THUMB_MAX_W, h: THUMB_MAX_W * 1.414 };
  let w = THUMB_MAX_W;
  let h = (size.height / size.width) * w;
  if (h > THUMB_MAX_H) {
    w = (THUMB_MAX_H / h) * w;
    h = THUMB_MAX_H;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

// ---------------------------------------------------------------------------
// Single thumbnail
// ---------------------------------------------------------------------------
interface ThumbProps {
  page: number;
  top: number;
  w: number;
  h: number;
  pageWidth: number;
  ready: boolean;
  active: boolean;
  count: number;
  calibrated: boolean;
  onSelect(page: number): void;
}

const Thumb = memo(function Thumb({
  page,
  top,
  w,
  h,
  pageWidth,
  ready,
  active,
  count,
  calibrated,
  onSelect,
}: ThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = (bmp: Thumbnail) => {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')?.drawImage(bmp, 0, 0);
      setDrawn(true);
    };
    const cached = cacheGet(page);
    if (cached) {
      draw(cached);
      return;
    }
    if (!ready) return;

    let cancelled = false;
    let task: { cancel(): void } | null = null;
    const timer = window.setTimeout(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const outW = Math.max(1, Math.round(w * dpr));
      const outH = Math.max(1, Math.round(h * dpr));
      const scale = Math.min(SUPERSAMPLE * outW, MAX_RENDER_PX) / pageWidth;
      countRender();
      const t = getPdfClient().render({ page, scale, priority: 0 });
      task = t;
      t.promise.then(
        (res) => {
          task = null;
          if (cancelled) {
            res.bitmap.close();
            return;
          }
          const thumb = downsample(res.bitmap, outW, outH);
          res.bitmap.close();
          cachePut(page, thumb);
          draw(thumb);
        },
        (err: unknown) => {
          task = null;
          if ((err as { name?: string })?.name !== 'AbortError' && !cancelled) {
            console.warn(`thumbnail ${page} failed`, err);
          }
        },
      );
    }, REQUEST_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
  }, [page, ready, w, h, pageWidth]);

  return (
    <div className="absolute inset-x-0 flex flex-col items-center" style={{ top, paddingTop: ITEM_PAD }}>
      <button
        type="button"
        onClick={() => onSelect(page)}
        aria-label={`דף ${page}`}
        aria-current={active ? 'page' : undefined}
        className={
          'relative block overflow-hidden rounded-sm bg-white transition-shadow focus:outline-none ' +
          (active
            ? 'ring-2 ring-sky-400 ring-offset-2 ring-offset-slate-800 shadow-lg shadow-sky-900/50'
            : 'ring-1 ring-slate-600 hover:ring-slate-400')
        }
        style={{ width: w, height: h }}
      >
        <canvas
          ref={canvasRef}
          data-thumb-page={page}
          data-state={drawn ? 'rendered' : 'pending'}
          className="block h-full w-full"
        />
        {!drawn && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-200">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
          </div>
        )}
        {count > 0 && (
          <span
            className="absolute end-1 top-1 min-w-[1.25rem] rounded-full bg-sky-600 px-1 text-center text-[10px] font-semibold leading-5 text-white shadow"
            title={`${count} מדידות בדף`}
          >
            {count}
          </span>
        )}
      </button>
      <div
        className={
          'flex items-center gap-1 text-[11px] tabular-nums ' + (active ? 'font-semibold text-sky-300' : 'text-slate-400')
        }
        style={{ height: LABEL_H }}
      >
        {calibrated && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="דף מכויל" />}
        {page}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
interface SidebarProps {
  /** When given (drawer mode), the header button hides the drawer instead of collapsing in place. */
  onHide?: () => void;
  /** Extra header buttons (e.g. the drawer's pin toggle). */
  headerActions?: ReactNode;
}

export default function ThumbnailSidebar({ onHide, headerActions }: SidebarProps = {}) {
  const numPages = useViewer((s) => s.numPages);
  const pageSizes = useViewer((s) => s.pageSizes);
  const currentPage = useViewer((s) => s.currentPage);
  const setPage = useViewer((s) => s.setPage);
  const measurements = useViewer((s) => s.measurements);
  const calibrations = useViewer((s) => s.calibrations);
  const [collapsed, setCollapsed] = useState(false);

  // Drop cached bitmaps when a new document is loaded.
  const docId = cacheReset(pageSizes);

  // Defer thumbnail rendering so the main page gets the worker first.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (numPages === 0) return;
    let idle = 0;
    const timer = window.setTimeout(() => {
      if ('requestIdleCallback' in window) {
        idle = window.requestIdleCallback(() => setReady(true), { timeout: 1500 });
      } else {
        setReady(true);
      }
    }, 600);
    return () => {
      window.clearTimeout(timer);
      if (idle && 'cancelIdleCallback' in window) window.cancelIdleCallback(idle);
    };
  }, [pageSizes, numPages]);

  // Layout: per-page slot offsets.
  const layout = useMemo(() => {
    const sizes: { w: number; h: number }[] = [];
    const offsets = new Float64Array(numPages + 1);
    let y = 0;
    for (let i = 0; i < numPages; i++) {
      const s = thumbSize(pageSizes[i]);
      sizes.push(s);
      offsets[i] = y;
      y += ITEM_PAD + s.h + LABEL_H + 4;
    }
    offsets[numPages] = y;
    return { sizes, offsets, total: y + ITEM_PAD };
  }, [numPages, pageSizes]);

  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const x of measurements) m.set(x.page, (m.get(x.page) ?? 0) + 1);
    return m;
  }, [measurements]);

  // Scroll / viewport tracking.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(800);
  const raf = useRef(0);
  const onScroll = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    setScrollTop(el.scrollTop);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed, numPages]);

  // Auto-scroll the current page into view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || numPages === 0) return;
    const i = currentPage - 1;
    const top = layout.offsets[i];
    const bottom = layout.offsets[i + 1];
    if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - (el.clientHeight - (bottom - top)) / 2);
      setScrollTop(el.scrollTop);
    }
  }, [currentPage, layout, numPages, collapsed]);

  // Visible window (binary search on offsets).
  const range = useMemo(() => {
    if (numPages === 0) return [0, -1] as const;
    const lo = Math.max(0, scrollTop - OVERSCAN_PX);
    const hi = scrollTop + viewportH + OVERSCAN_PX;
    const find = (y: number) => {
      let a = 0;
      let b = numPages - 1;
      while (a < b) {
        const m = (a + b + 1) >> 1;
        if (layout.offsets[m] <= y) a = m;
        else b = m - 1;
      }
      return a;
    };
    return [find(lo), find(hi)] as const;
  }, [scrollTop, viewportH, layout, numPages]);

  if (numPages === 0) return null;

  if (collapsed) {
    return (
      <aside className="flex w-8 shrink-0 flex-col items-center border-e border-slate-700 bg-slate-800 py-2">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="הצג תצוגה מקדימה של דפים"
          className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-white"
        >
          <IconPanel />
        </button>
        <div className="mt-3 text-[10px] text-slate-500 [writing-mode:vertical-rl]">
          דף {currentPage} / {numPages}
        </div>
      </aside>
    );
  }

  const items = [];
  for (let i = range[0]; i <= range[1]; i++) {
    const page = i + 1;
    const s = layout.sizes[i];
    items.push(
      <Thumb
        key={`${docId}:${page}`}
        page={page}
        top={layout.offsets[i]}
        w={s.w}
        h={s.h}
        pageWidth={pageSizes[i]?.width || 612}
        ready={ready}
        active={page === currentPage}
        count={counts.get(page) ?? 0}
        calibrated={!!calibrations[page]}
        onSelect={setPage}
      />,
    );
  }

  return (
    <aside className="flex w-[184px] shrink-0 flex-col border-e border-slate-700 bg-slate-800/80">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-slate-700 px-2 text-[11px] text-slate-400">
        <span>דפים ({numPages})</span>
        <div className="flex-1" />
        {headerActions}
        <button
          type="button"
          onClick={() => (onHide ? onHide() : setCollapsed(true))}
          title={onHide ? 'סגור (T)' : 'הסתר'}
          aria-label="סגור תצוגת דפים"
          className="rounded p-0.5 text-slate-400 hover:bg-slate-700 hover:text-white"
        >
          <IconPanel size={14} />
        </button>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="relative" style={{ height: layout.total }}>
          {items}
        </div>
      </div>
    </aside>
  );
}
