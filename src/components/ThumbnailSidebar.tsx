import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useViewer } from '../state/store';
import { getPdfClient } from '../core/pdfClient';
import type { PageSize, WorkspaceDoc } from '../core/types';
import { useFileQueue } from '../state/fileQueue';
import { IconFilePdf, IconPanel, IconX } from './ui/icons';
import { persistentMeasurements } from '../core/tempMeasurements';
import { useShallow } from 'zustand/react/shallow';
import { useCompare } from '../compare/compareStore';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const THUMB_MAX_W = 140;
const THUMB_MAX_H = 200;
const ITEM_PAD = 8; // vertical padding inside a slot (top)
const LABEL_H = 20; // page-number row under each thumb
const HEADER_H = 44; // per-file header row
const FOOTER_H = 64; // pending files + "add" button after the last file (base height)
const PENDING_ROW_H = 26;
const OVERSCAN_PX = 400;
/** A thumb must stay visible this long before its render is requested (fast-scroll filter). */
const REQUEST_DELAY_MS = 120;
const CACHE_LIMIT = 60;

// ---------------------------------------------------------------------------
// LRU cache of rendered thumbnails (module-level so it survives collapse).
// ---------------------------------------------------------------------------
/** Cached thumbs are small, already-downsampled canvases (cheap to keep ~60). */
type Thumbnail = OffscreenCanvas | HTMLCanvasElement;
/**
 * Keyed by `${docId}:${localPage}` — doc ids are unique per session, so adding
 * or removing another file (which renumbers global pages) never invalidates
 * or mixes up cached thumbnails.
 */
const cache = new Map<string, Thumbnail>();

function cacheGet(key: string): Thumbnail | undefined {
  const b = cache.get(key);
  if (b) {
    cache.delete(key);
    cache.set(key, b); // bump recency
  }
  return b;
}
function cachePut(key: string, bitmap: Thumbnail) {
  cache.delete(key);
  cache.set(key, bitmap);
  while (cache.size > CACHE_LIMIT) {
    const k = cache.keys().next().value as string;
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
  /** Global page number (what render() / setPage take). */
  page: number;
  /** Page number inside its file (shown under the thumb). */
  localPage: number;
  cacheKey: string;
  top: number;
  w: number;
  h: number;
  pageWidth: number;
  ready: boolean;
  active: boolean;
  count: number;
  /** Version-compare changes on this page (null = page not part of a compare). */
  changes: number | null;
  calibrated: boolean;
  onSelect(page: number): void;
}

const Thumb = memo(function Thumb({
  page,
  localPage,
  cacheKey,
  top,
  w,
  h,
  pageWidth,
  ready,
  active,
  count,
  changes,
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
    const cached = cacheGet(cacheKey);
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
          cachePut(cacheKey, thumb);
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
  }, [page, cacheKey, ready, w, h, pageWidth]);

  return (
    <div className="absolute inset-x-0 flex flex-col items-center" style={{ top, paddingTop: ITEM_PAD }}>
      <button
        type="button"
        onClick={() => onSelect(page)}
        aria-label={`דף ${page}`}
        title={localPage !== page ? `דף ${localPage} בקובץ (דף ${page} כולל)` : undefined}
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
        {changes != null && (
          <span
            data-testid="thumb-changes"
            className={
              'absolute start-1 top-1 min-w-[1.25rem] rounded-full px-1 text-center text-[10px] font-bold leading-5 text-white ' +
              (changes > 0 ? 'bg-pink-600 shadow-[0_0_8px_rgba(255,42,149,0.9)]' : 'bg-slate-500/80')
            }
            title={changes > 0 ? `${changes} שינויים בדף` : 'ללא שינויים'}
          >
            {changes > 0 ? changes : '✓'}
          </span>
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
        {localPage}
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

const PlusIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** "+ הוסף קובץ PDF" — opens a multi-select file picker. */
function AddFileButton({ onPick, testId, compact }: { onPick(): void; testId: string; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onPick}
      data-testid={testId}
      title="הוסף קובצי PDF לסביבת העבודה (ניתן לבחור כמה)"
      className={
        'flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-sky-600/80 bg-sky-950/40 font-semibold text-sky-200 ' +
        'transition-colors hover:border-sky-400 hover:bg-sky-900/50 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 ' +
        (compact ? 'h-8 text-[11px]' : 'h-9 text-xs')
      }
    >
      <PlusIcon size={compact ? 14 : 16} />
      הוסף קובץ PDF
    </button>
  );
}

/** Per-file header: name, page count, remove ✕ with an inline confirm. */
function FileHeader({
  doc,
  top,
  active,
  measured,
  confirming,
  onAskRemove,
  onCancel,
  onRemove,
  onSelect,
}: {
  doc: WorkspaceDoc;
  top: number;
  active: boolean;
  measured: number;
  confirming: boolean;
  onAskRemove(): void;
  onCancel(): void;
  onRemove(): void;
  onSelect(): void;
}) {
  return (
    <div
      className="absolute inset-x-1 flex items-end"
      style={{ top, height: HEADER_H }}
      data-testid="file-header"
      data-doc-id={doc.id}
    >
      {confirming ? (
        <div
          role="alertdialog"
          aria-label={`הסרת ${doc.name}`}
          className="flex h-9 w-full items-center gap-1 rounded-md border border-red-800 bg-red-950/80 px-1.5 text-[11px] text-red-100"
        >
          <span className="min-w-0 flex-1 truncate" title={measured ? `${measured} מדידות יוסרו מהתצוגה (נשמרות לקובץ)` : undefined}>
            להסיר קובץ?
          </span>
          <button
            type="button"
            onClick={onRemove}
            data-testid="confirm-remove-file"
            className="rounded bg-red-700 px-1.5 py-0.5 font-semibold text-white hover:bg-red-600"
          >
            הסר
          </button>
          <button type="button" onClick={onCancel} className="rounded px-1.5 py-0.5 text-red-200 hover:bg-red-900">
            ביטול
          </button>
        </div>
      ) : (
        <div
          className={
            'flex h-9 w-full items-center gap-1 rounded-md border px-1.5 text-[11px] ' +
            (active ? 'border-sky-700/70 bg-sky-950/50 text-sky-100' : 'border-slate-700 bg-slate-900/60 text-slate-300')
          }
        >
          <IconFilePdf size={14} className="shrink-0 text-red-400" />
          <button
            type="button"
            onClick={onSelect}
            className="min-w-0 flex-1 truncate text-start font-semibold hover:text-white"
            title={`${doc.name} — ${doc.numPages} דפים`}
            dir="auto"
          >
            {doc.name}
          </button>
          <span className="shrink-0 tabular-nums text-slate-500">{doc.numPages}</span>
          <button
            type="button"
            onClick={onAskRemove}
            aria-label={`הסר את ${doc.name}`}
            title="הסר קובץ"
            data-testid="remove-file"
            className="shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-700 hover:text-red-300"
          >
            <IconX size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

export default function ThumbnailSidebar({ onHide, headerActions }: SidebarProps = {}) {
  const numPages = useViewer((s) => s.numPages);
  const pageSizes = useViewer((s) => s.pageSizes);
  const docs = useViewer((s) => s.docs);
  const currentPage = useViewer((s) => s.currentPage);
  const setPage = useViewer((s) => s.setPage);
  const cmp = useCompare(useShallow((s) => ({ status: s.status, oldId: s.oldId, newId: s.newId, regions: s.regions, progress: s.progress })));
  const measurements = useViewer((s) => persistentMeasurements(s.measurements));
  const calibrations = useViewer((s) => s.calibrations);
  const queued = useFileQueue((s) => s.items);
  const [collapsed, setCollapsed] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pick = useCallback(() => fileInput.current?.click(), []);

  // Defer thumbnail rendering so the main page gets the worker first (only
  // when a new workspace is opened — not when a file is added).
  const firstDocId = docs[0]?.id;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (!firstDocId) return;
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
  }, [firstDocId]);

  // Layout: per-file header + per-page slot offsets, then the footer.
  const layout = useMemo(() => {
    const sizes: { w: number; h: number }[] = [];
    const offsets = new Float64Array(numPages + 1);
    /** Per global page index: owning doc + local page. */
    const owner: { doc: WorkspaceDoc; local: number }[] = [];
    const headers: { doc: WorkspaceDoc; top: number }[] = [];
    let y = 0;
    let i = 0;
    const groups: WorkspaceDoc[] = docs.length
      ? docs
      : [{ id: 'doc', name: '', numPages, pageOffset: 0, pageSizes }];
    for (const d of groups) {
      if (docs.length) {
        headers.push({ doc: d, top: y });
        y += HEADER_H;
      }
      for (let k = 0; k < d.numPages && i < numPages; k++, i++) {
        const s = thumbSize(pageSizes[i]);
        sizes.push(s);
        owner.push({ doc: d, local: k + 1 });
        offsets[i] = y;
        y += ITEM_PAD + s.h + LABEL_H + 4;
      }
    }
    for (; i < numPages; i++) {
      // Defensive: pages not covered by docs (should not happen).
      const s = thumbSize(pageSizes[i]);
      sizes.push(s);
      owner.push({ doc: groups[groups.length - 1], local: i + 1 });
      offsets[i] = y;
      y += ITEM_PAD + s.h + LABEL_H + 4;
    }
    offsets[numPages] = y;
    return { sizes, offsets, owner, headers, footerTop: y + ITEM_PAD, total: y + ITEM_PAD };
  }, [numPages, pageSizes, docs]);

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
    // Include the file header when the page is its file's first page.
    const top = layout.owner[i]?.local === 1 ? layout.offsets[i] - HEADER_H : layout.offsets[i];
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

  const addFiles = useFileQueue((s) => s.addFiles);
  const removeDoc = useFileQueue((s) => s.removeDoc);
  const input = (
    <input
      ref={fileInput}
      type="file"
      accept="application/pdf,.pdf"
      multiple
      className="hidden"
      data-testid="add-file-input"
      onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (files.length) addFiles(files);
      }}
    />
  );

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
        <button
          type="button"
          onClick={pick}
          title="הוסף קובץ PDF"
          aria-label="הוסף קובץ PDF"
          className="mt-2 rounded p-1 text-sky-300 hover:bg-slate-700 hover:text-white"
        >
          <PlusIcon />
        </button>
        {input}
        <div className="mt-3 text-[10px] text-slate-500 [writing-mode:vertical-rl]">
          דף {currentPage} / {numPages}
        </div>
      </aside>
    );
  }

  const cmpChanges = (docId: string, local: number): number | null => {
    if (cmp.status === 'idle' || (docId !== cmp.oldId && docId !== cmp.newId)) return null;
    const n = cmp.regions[docId]?.[local]?.length ?? 0;
    // Not compared yet (still running) → no badge.
    if (!n && cmp.status === 'running' && local > cmp.progress.done) return null;
    return n;
  };
  const items = [];
  for (let i = range[0]; i <= range[1]; i++) {
    const page = i + 1;
    const s = layout.sizes[i];
    const own = layout.owner[i];
    const cacheKey = `${own.doc.id}:${own.local}`;
    items.push(
      <Thumb
        key={cacheKey}
        page={page}
        localPage={own.local}
        cacheKey={cacheKey}
        top={layout.offsets[i]}
        w={s.w}
        h={s.h}
        pageWidth={pageSizes[i]?.width || 612}
        ready={ready}
        active={page === currentPage}
        count={counts.get(page) ?? 0}
        changes={cmpChanges(own.doc.id, own.local)}
        calibrated={!!calibrations[page]}
        onSelect={setPage}
      />,
    );
  }
  // Headers are few (one per file): render all of them.
  for (const { doc, top } of layout.headers) {
    let measured = 0;
    for (let p = doc.pageOffset + 1; p <= doc.pageOffset + doc.numPages; p++) measured += counts.get(p) ?? 0;
    items.push(
      <FileHeader
        key={`h:${doc.id}`}
        doc={doc}
        top={top}
        active={currentPage > doc.pageOffset && currentPage <= doc.pageOffset + doc.numPages}
        measured={measured}
        confirming={confirmId === doc.id}
        onAskRemove={() => setConfirmId(doc.id)}
        onCancel={() => setConfirmId(null)}
        onRemove={() => {
          setConfirmId(null);
          removeDoc(doc.id);
        }}
        onSelect={() => setPage(doc.pageOffset + 1)}
      />,
    );
  }
  const footerH = FOOTER_H + queued.length * PENDING_ROW_H;

  return (
    <aside className="flex w-[184px] shrink-0 flex-col border-e border-slate-700 bg-slate-800/80">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-slate-700 px-2 text-[11px] text-slate-400">
        <span>
          דפים ({numPages}){docs.length > 1 ? ` · ${docs.length} קבצים` : ''}
        </span>
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
      <div className="shrink-0 border-b border-slate-700/70 p-1.5">
        <AddFileButton onPick={pick} testId="add-file-top" />
      </div>
      {input}
      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="relative" style={{ height: layout.total + footerH }}>
          {items}
          <div className="absolute inset-x-1 flex flex-col gap-1 pt-1" style={{ top: layout.footerTop }}>
            {queued.map((q) => (
              <div
                key={q.key}
                data-testid="file-pending"
                data-status={q.status}
                className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/60 px-1.5 text-[11px] text-slate-400"
                style={{ height: PENDING_ROW_H - 4 }}
                title={q.error ?? q.name}
              >
                {q.status === 'error' ? (
                  <span className="shrink-0 font-bold text-red-400">!</span>
                ) : (
                  <span
                    className={
                      'h-3 w-3 shrink-0 rounded-full border-2 ' +
                      (q.status === 'loading' ? 'animate-spin border-slate-500 border-t-sky-400' : 'border-slate-600')
                    }
                  />
                )}
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {q.name}
                </span>
                <span className="shrink-0">{q.status === 'loading' ? 'טוען…' : q.status === 'error' ? 'נכשל' : 'ממתין'}</span>
              </div>
            ))}
            <AddFileButton onPick={pick} testId="add-file-bottom" compact />
          </div>
        </div>
      </div>
    </aside>
  );
}
