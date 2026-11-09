import { scrollWithin } from '../ui/scrollWithin';
import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../../state/store';
import { useFileQueue } from '../../state/fileQueue';
import { activeDocId, appendedDocIds, cycleDoc, pageForTab, pruneLastPages, rememberPage, type LastPages } from '../../state/docTabs';
import { useSearch } from '../../text/searchStore';
import { IconSearch, openSearch } from '../text/SearchPanel';
import { IconFilePdf, IconX } from '../ui/icons';
import type { WorkspaceDoc } from '../../core/types';

/** Height of the tab bar (Tailwind h-9); the viewer region starts below it. */
export const TABBAR_H = '2.25rem';

// ---------------------------------------------------------------------------
// Last page viewed per file (module state: survives tab bar re-renders)
// ---------------------------------------------------------------------------

let lastPages: LastPages = {};
let prevDocs: WorkspaceDoc[] = useViewer.getState().docs;

useViewer.subscribe((s, prev) => {
  if (s.docs !== prev.docs) {
    lastPages = pruneLastPages(lastPages, s.docs);
    // A file appended to the workspace (not a replace) becomes the active tab.
    const added = appendedDocIds(prevDocs, s.docs);
    prevDocs = s.docs;
    const doc = added.length ? s.docs.find((d) => d.id === added[added.length - 1]) : undefined;
    if (doc && activeDocId(s.docs, s.currentPage) !== doc.id) {
      queueMicrotask(() => useViewer.getState().setPage(doc.pageOffset + 1));
      return;
    }
  }
  if (s.currentPage !== prev.currentPage || s.docs !== prev.docs) lastPages = rememberPage(lastPages, s.docs, s.currentPage);
});

/** Switches to `doc`'s tab (its last viewed page). */
export function activateDoc(doc: WorkspaceDoc): void {
  const v = useViewer.getState();
  if (activeDocId(v.docs, v.currentPage) === doc.id) return;
  v.setPage(pageForTab(lastPages, doc));
}

/** Ctrl+Tab / Ctrl+Shift+Tab (where the browser lets the page see them, e.g. the desktop app). */
function useTabKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.altKey || e.metaKey) return;
      const v = useViewer.getState();
      if (v.docs.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const id = cycleDoc(v.docs, activeDocId(v.docs, v.currentPage), e.shiftKey ? -1 : 1);
      const doc = v.docs.find((d) => d.id === id);
      if (doc) activateDoc(doc);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

const PlusIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

interface Confirm {
  doc: WorkspaceDoc;
  measured: number;
  /** Viewport x of the tab's centre (popover anchor). */
  x: number;
}

/**
 * Slim full-width bar above the viewer: one tab per open file (+ queued files
 * while they load), a "+" tab that adds files, and the "search in files" box.
 */
export function FileTabBar() {
  useTabKeys();
  const docs = useViewer((s) => s.docs);
  const currentPage = useViewer((s) => s.currentPage);
  const queued = useFileQueue((s) => s.items);
  const addFiles = useFileQueue((s) => s.addFiles);
  const removeDoc = useFileQueue((s) => s.removeDoc);
  const fileInput = useRef<HTMLInputElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const activeId = activeDocId(docs, currentPage);

  // Vertical wheel over the strip scrolls it horizontally.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      // RTL: scrolling "forward" (wheel down) moves toward the end (left).
      el.scrollLeft -= d;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Keep the active tab in view.
  useEffect(() => {
    scrollWithin(strip.current?.querySelector('[data-active="true"]'), 'x');
  }, [activeId, docs.length]);

  // Close the confirm popover on outside click / Esc.
  useEffect(() => {
    if (!confirm) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('[data-testid="tab-confirm"]')) setConfirm(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setConfirm(null);
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [confirm]);

  const askClose = (doc: WorkspaceDoc, anchor: HTMLElement) => {
    const { measurements } = useViewer.getState();
    const lo = doc.pageOffset;
    const hi = doc.pageOffset + doc.numPages;
    const measured = measurements.filter((m) => m.page > lo && m.page <= hi).length;
    if (!measured) {
      removeDoc(doc.id);
      return;
    }
    const r = anchor.getBoundingClientRect();
    setConfirm({ doc, measured, x: r.left + r.width / 2 });
  };

  if (docs.length === 0) return null;
  const pendingTabs = queued.filter((q) => q.status !== 'error');

  return (
    <div
      dir="rtl"
      data-testid="file-tabbar"
      className="absolute inset-x-0 top-0 z-[45] flex h-9 items-stretch border-b border-slate-700/80 bg-slate-900 text-slate-300 shadow-md shadow-black/30"
    >
      <div
        ref={strip}
        role="tablist"
        aria-label="קבצים פתוחים"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {docs.map((doc) => {
          const active = doc.id === activeId;
          const title = doc.name.replace(/\.pdf$/i, '');
          return (
            <div
              key={doc.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-testid="file-tab"
              data-doc-id={doc.id}
              data-active={active ? 'true' : 'false'}
              title={`${doc.name} · ${doc.numPages} ${doc.numPages === 1 ? 'דף' : 'דפים'}`}
              onClick={() => activateDoc(doc)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  activateDoc(doc);
                }
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault(); // no autoscroll cursor
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  askClose(doc, e.currentTarget);
                }
              }}
              className={
                'group relative flex min-w-[6.5rem] max-w-[14rem] shrink-0 cursor-pointer select-none items-center gap-1.5 border-e border-slate-700/70 ps-2.5 pe-1 text-xs outline-none ' +
                'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-400 ' +
                (active ? 'bg-slate-800 text-white' : 'bg-slate-900 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200')
              }
            >
              {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-sky-500" aria-hidden="true" />}
              <IconFilePdf size={14} className={'shrink-0 ' + (active ? 'text-red-400' : 'text-red-400/60')} />
              <span className="min-w-0 flex-1 truncate" dir="auto" data-testid="file-tab-name">
                {title}
              </span>
              <span
                className={'shrink-0 rounded px-1 text-[10px] tabular-nums leading-4 ' + (active ? 'bg-slate-700 text-slate-300' : 'bg-slate-800 text-slate-500')}
                aria-label={`${doc.numPages} דפים`}
              >
                {doc.numPages}
              </span>
              <button
                type="button"
                data-testid="file-tab-close"
                aria-label={`סגור ${doc.name}`}
                title="סגור קובץ (לחיצה אמצעית)"
                onClick={(e) => {
                  e.stopPropagation();
                  askClose(doc, e.currentTarget.parentElement!);
                }}
                className={
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-600 hover:text-white ' +
                  (active ? '' : 'opacity-60 group-hover:opacity-100')
                }
              >
                <IconX size={12} />
              </button>
            </div>
          );
        })}
        {pendingTabs.map((q) => (
          <div
            key={`q${q.key}`}
            data-testid="file-tab-pending"
            title={q.name}
            className="flex min-w-[6.5rem] max-w-[12rem] shrink-0 items-center gap-1.5 border-e border-slate-700/70 px-2.5 text-xs text-slate-500"
          >
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" aria-hidden="true" />
            <span className="min-w-0 truncate" dir="auto">
              {q.name.replace(/\.pdf$/i, '')}
            </span>
          </div>
        ))}
        <button
          type="button"
          data-testid="file-tab-add"
          onClick={() => fileInput.current?.click()}
          title="הוסף קובץ PDF (ייפתח בלשונית חדשה)"
          aria-label="הוסף קובץ PDF"
          className="flex w-9 shrink-0 items-center justify-center text-sky-300 hover:bg-slate-800 hover:text-white"
        >
          <PlusIcon />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          data-testid="tabbar-add-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) addFiles(files);
          }}
        />
      </div>

      <TabbarSearch />

      {confirm && (
        <div
          role="alertdialog"
          aria-label={`סגירת ${confirm.doc.name}`}
          data-testid="tab-confirm"
          style={{ left: `clamp(0.5rem, calc(${confirm.x}px - 8rem), calc(100vw - 16.5rem))` }}
          className="fixed top-10 z-50 w-64 rounded-lg border border-red-800 bg-slate-900/95 p-2.5 text-xs text-slate-200 shadow-2xl shadow-black/60 backdrop-blur"
        >
          <div className="mb-1 font-medium">
            לסגור את <span dir="auto">„{confirm.doc.name}”</span>?
          </div>
          <div className="mb-2 text-[11px] text-slate-400">
            {confirm.measured} מדידות יוסרו מהתצוגה (נשמרות לקובץ וישוחזרו כשיפתח שוב).
          </div>
          <div className="flex justify-end gap-1">
            <button
              type="button"
              autoFocus
              data-testid="tab-confirm-close"
              onClick={() => {
                const id = confirm.doc.id;
                setConfirm(null);
                removeDoc(id);
              }}
              className="rounded bg-red-700 px-2.5 py-1 font-semibold text-white hover:bg-red-600"
            >
              סגור קובץ
            </button>
            <button type="button" onClick={() => setConfirm(null)} className="rounded px-2.5 py-1 text-slate-300 hover:bg-slate-700">
              ביטול
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "חיפוש בתוכן הקבצים…": feeds the search panel (scope = all files); Enter searches, Enter again = next result. */
function TabbarSearch() {
  const query = useSearch((s) => s.query);
  const setQuery = useSearch((s) => s.setQuery);

  const submit = (back: boolean) => {
    const s = useSearch.getState();
    if (!s.open) s.setOpen(true);
    // Same search already shown → step through the results.
    if (s.ranQuery === s.query && s.scope === 'all' && s.results.length && !s.running) {
      const n = s.results.length;
      s.goTo(((s.activeIndex < 0 ? (back ? 0 : -1) : s.activeIndex) + (back ? -1 : 1) + n) % n);
      return;
    }
    s.setScope('all');
    void s.run();
  };

  return (
    <form
      role="search"
      className="flex shrink-0 items-center border-s border-slate-700/80 px-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      <label className="relative flex items-center">
        <span className="pointer-events-none absolute right-2 text-slate-500">
          <IconSearch size={13} />
        </span>
        <input
          type="search"
          dir="auto"
          data-testid="tabbar-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation(); // typing must not trigger tool shortcuts
            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault();
              submit(true);
            } else if (e.key === 'Escape') {
              if (useSearch.getState().open) useSearch.getState().setOpen(false);
              e.currentTarget.blur();
            }
          }}
          placeholder="חיפוש בתוכן הקבצים…"
          aria-label="חיפוש בתוכן הקבצים (Ctrl+F)"
          title="חיפוש בתוכן הקבצים (Ctrl+F) — Enter לחיפוש / לתוצאה הבאה"
          className={
            'h-7 w-36 rounded-md border border-slate-700 bg-slate-950 pl-2 pr-7 text-xs text-slate-100 placeholder:text-slate-500 ' +
            'transition-[width] duration-150 focus:w-48 focus:border-sky-500 [&::-webkit-search-cancel-button]:hidden focus:outline-none sm:w-52 sm:focus:w-64'
          }
        />
      </label>
      <button
        type="button"
        onClick={() => openSearch()}
        title="אפשרויות חיפוש וספירה (F3)"
        aria-label="פתח חלון חיפוש וספירה"
        data-testid="tabbar-search-options"
        className="ms-0.5 hidden h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white sm:flex"
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
          <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
          <circle cx="16" cy="6" r="2" />
          <circle cx="10" cy="12" r="2" />
          <circle cx="18" cy="18" r="2" />
        </svg>
      </button>
    </form>
  );
}
