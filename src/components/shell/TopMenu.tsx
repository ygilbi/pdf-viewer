import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { useZoom, viewerCommands } from '../viewer/commands';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFit,
  IconFolderOpen,
  IconFullscreen,
  IconFullscreenExit,
  IconList,
  IconPages,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from '../ui/icons';
import { openExportDialog } from '../../export/exportUi';
import { ActiveCategorySelect } from '../CategorySelect';
import { fullscreenSupported, toggleFullscreen, useIsFullscreen } from '../toolActions';
import { signOut, useAuthUser } from '../../auth/session';
import { toggleLeftTab } from '../../pricing/LeftDrawer';
import { IconSearch, openSearch } from '../text/searchControls';
import { cancelSaveAs, dismissSaveAs, saveAsMarked, useSaveAs } from '../../export/saveAs';
import { useCompactLayout } from './layout';
import { TABBAR_H } from './FileTabBar';
import { visibleTopMenu, type TopMenuItemId } from './topMenuItems';
import { sendToGilboa } from '../SendToGilboaButton';
import { kindOf } from '../../core/measurementEngine';
import { IconCompare } from '../../compare/ComparePanel';
import { openCompareDialog, useCompare } from '../../compare/compareStore';

/** Paper-plane icon for "שלח לגלבוע". */
function IconSend() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}
const TAKEOFF_KINDS = new Set(['area', 'deduct', 'length', 'count']);

/** Bar height: slim on desktop, 44px touch targets (+ padding) on phones / touch. */
export const TOPMENU_H = '2.5rem';
export const TOPMENU_H_COMPACT = '3rem';
export const topMenuHeight = (compact: boolean) => (compact ? TOPMENU_H_COMPACT : TOPMENU_H);

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SAVE_AS_KEYS = `${isMac ? '⌘' : 'Ctrl'}+Shift+S`;

const IconSave = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M7 3v5h8V3" />
    <path d="M7 21v-7h10v7" />
  </svg>
);

const IconLogout = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    <path d="M9 16l-4-4 4-4" />
    <path d="M5 12h11" />
  </svg>
);

interface BarButtonProps {
  label: string;
  /** Shown in the native tooltip (title) after the label. */
  shortcut?: string;
  icon: ReactNode;
  onClick(e?: { shiftKey?: boolean }): void;
  disabled?: boolean;
  active?: boolean;
  /** Show the label next to the icon (wide desktop only; phones are icons only). */
  showLabel?: boolean;
  compact: boolean;
  testId: string;
}

function BarButton({ label, shortcut, icon, onClick, disabled, active, showLabel, compact, testId }: BarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={
        'flex shrink-0 items-center justify-center gap-1.5 rounded text-xs transition-colors ' +
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-40 ' +
        (compact ? 'h-11 min-w-11 px-2.5 ' : 'h-8 min-w-8 px-2 ') +
        (active ? 'bg-sky-600 text-white shadow-inner' : 'text-slate-300 hover:bg-slate-700 hover:text-white')
      }
    >
      {icon}
      {showLabel && !compact && <span className="hidden whitespace-nowrap xl:inline">{label}</span>}
    </button>
  );
}

const Divider = () => <div className="mx-1 h-5 w-px shrink-0 bg-slate-700" aria-hidden="true" />;

/**
 * The permanent top bar under the file tabs (no ☰ dropdown): the essentials only — file (open,
 * Save As), pages, zoom, search, export, [category — edit mode], view, user. Desktop: one slim
 * row (icons + labels on wide windows). Phones: one row of 44px icons that scrolls sideways.
 * Light on purpose (visible at first paint): the export dialog / search panel are opened through
 * their stores and stay lazy chunks; Save As loads the export pipeline on click.
 */
export function TopMenu({ onOpenFile }: { onOpenFile(file: File): void }) {
  const thumbsOpen = useUi((s) => s.thumbsOpen);
  const measOpen = useUi((s) => s.measurementsOpen);
  const toggleDrawer = useUi((s) => s.toggleDrawer);
  const editMode = useUi((s) => s.editMode);

  const numPages = useViewer((s) => s.numPages);
  const currentPage = useViewer((s) => s.currentPage);
  const setPage = useViewer((s) => s.setPage);
  const zoom = useZoom().percent;
  const isFs = useIsFullscreen();
  const authUser = useAuthUser((s) => s.user);
  const saving = useSaveAs((s) => s.status?.phase === 'running');
  const compact = useCompactLayout();
  const hasDoc = numPages > 0;
  // Saved takeoff quantities (not markup, not temporary view-mode checks): what "שלח לגלבוע" sends.
  const takeoffCount = useViewer((s) => s.measurements.reduce((n, x) => (!x.temp && TAKEOFF_KINDS.has(kindOf(x)) ? n + 1 : n), 0));

  const comparing = useCompare((s) => s.status !== 'idle');
  const fileInput = useRef<HTMLInputElement>(null);
  const row = useRef<HTMLDivElement>(null);

  useSaveAsKey();

  // Vertical wheel over an overflowing bar scrolls it sideways (narrow desktop windows).
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      el.scrollLeft -= d; // RTL: forward = toward the end (left)
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // null while not editing → the input mirrors currentPage.
  const [pageText, setPageText] = useState<string | null>(null);
  const commitPage = () => {
    if (pageText == null) return;
    const n = parseInt(pageText, 10);
    if (Number.isFinite(n)) setPage(n);
    setPageText(null);
  };

  const groups = visibleTopMenu({ editMode, fullscreen: fullscreenSupported(), signedIn: !!authUser });

  const render = (id: TopMenuItemId): ReactNode => {
    const common = { compact };
    switch (id) {
      case 'open':
        return (
          <BarButton key={id} {...common} testId="menu-open" label="פתח קובץ" icon={<IconFolderOpen />} showLabel onClick={() => fileInput.current?.click()} />
        );
      case 'saveAs':
        return (
          <BarButton
            key={id}
            {...common}
            testId="menu-save-as"
            label="שמור בשם"
            shortcut={SAVE_AS_KEYS}
            icon={<IconSave />}
            showLabel
            disabled={!hasDoc || saving}
            onClick={saveAsMarked}
          />
        );
      case 'compare':
        return (
          <BarButton
            key={id}
            {...common}
            testId="menu-compare"
            label="השוואת גרסאות"
            icon={<IconCompare />}
            showLabel
            active={comparing}
            disabled={!hasDoc}
            onClick={openCompareDialog}
          />
        );
      case 'prevPage':
        return (
          <BarButton
            key={id}
            {...common}
            testId="menu-prev-page"
            label="הדף הקודם"
            shortcut="PageUp"
            icon={<IconChevronRight />}
            disabled={!hasDoc || currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          />
        );
      case 'page':
        return (
          <div key={id} className="flex shrink-0 items-center gap-1 px-0.5 text-xs text-slate-400" data-testid="menu-page">
            <span className={compact ? 'sr-only' : ''}>דף</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label="מספר דף"
              data-testid="menu-page-input"
              disabled={!hasDoc}
              value={hasDoc ? (pageText ?? String(currentPage)) : ''}
              onChange={(e) => setPageText(e.target.value.replace(/[^\d]/g, ''))}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  commitPage();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Escape') {
                  setPageText(null);
                  requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
                }
              }}
              onBlur={commitPage}
              onFocus={(e) => e.target.select()}
              className={
                'rounded border border-slate-600 bg-slate-900 text-center font-mono text-slate-100 focus:border-sky-500 focus:outline-none disabled:opacity-40 ' +
                // 16px on phones: iOS zooms the page into smaller inputs.
                (compact ? 'h-9 w-12 text-base' : 'h-6 w-11 text-xs')
              }
            />
            <span className="whitespace-nowrap">מתוך {hasDoc ? numPages : '—'}</span>
          </div>
        );
      case 'nextPage':
        return (
          <BarButton
            key={id}
            {...common}
            testId="menu-next-page"
            label="הדף הבא"
            shortcut="PageDown"
            icon={<IconChevronLeft />}
            disabled={!hasDoc || currentPage >= numPages}
            onClick={() => setPage(currentPage + 1)}
          />
        );
      case 'zoomOut':
        return <BarButton key={id} {...common} testId="menu-zoom-out" label="הקטן" shortcut="-" icon={<IconZoomOut />} disabled={!hasDoc} onClick={() => viewerCommands.zoomOut()} />;
      case 'zoomLevel':
        return (
          <div key={id} className="w-11 shrink-0 text-center font-mono text-xs tabular-nums text-slate-300" aria-label="זום" data-testid="menu-zoom" dir="ltr">
            {hasDoc ? `${Math.round(zoom)}%` : '—'}
          </div>
        );
      case 'zoomIn':
        return <BarButton key={id} {...common} testId="menu-zoom-in" label="הגדל" shortcut="+" icon={<IconZoomIn />} disabled={!hasDoc} onClick={() => viewerCommands.zoomIn()} />;
      case 'fit':
        return <BarButton key={id} {...common} testId="menu-fit" label="התאם" shortcut="0 / F" icon={<IconFit />} showLabel disabled={!hasDoc} onClick={() => viewerCommands.fit()} />;
      case 'search':
        return <BarButton key={id} {...common} testId="menu-search" label="חיפוש" shortcut="F3" icon={<IconSearch />} showLabel disabled={!hasDoc} onClick={() => openSearch()} />;
      case 'export':
        return <BarButton key={id} {...common} testId="menu-export" label="ייצוא" shortcut="E" icon={<IconDownload />} showLabel disabled={!hasDoc} onClick={() => openExportDialog()} />;
      case 'gilboa':
        return (
          <BarButton
            key={id}
            {...common}
            testId="menu-gilboa"
            label="שלח לגלבוע"
            icon={<IconSend />}
            showLabel
            disabled={!hasDoc || takeoffCount === 0}
            onClick={(e) => sendToGilboa(e)}
          />
        );
      case 'category':
        return (
          <div key={id} className="shrink-0" data-testid="menu-category">
            <ActiveCategorySelect />
          </div>
        );
      case 'thumbs':
        return (
          <BarButton key={id} {...common} testId="menu-thumbs" label="תצוגת דפים" shortcut="T" icon={<IconPages />} showLabel active={thumbsOpen} disabled={!hasDoc} onClick={() => toggleDrawer('thumbs')} />
        );
      case 'items':
        return (
          <BarButton key={id} {...common} testId="menu-items" label="טבלת פריטים" shortcut="M" icon={<IconList />} showLabel active={measOpen} disabled={!hasDoc} onClick={() => toggleLeftTab()} />
        );
      case 'fullscreen':
        return (
          <BarButton
            key={id}
            {...common}
            testId="menu-fullscreen"
            label={isFs ? 'צא ממסך מלא' : 'מסך מלא'}
            shortcut="Shift+F"
            icon={isFs ? <IconFullscreenExit /> : <IconFullscreen />}
            showLabel
            active={isFs}
            onClick={toggleFullscreen}
          />
        );
      case 'user':
        return authUser ? (
          <span
            key={id}
            className={'shrink-0 truncate px-1 text-xs text-slate-400 ' + (compact ? 'max-w-[6rem]' : 'max-w-[10rem]')}
            dir="auto"
            title={authUser.email}
            data-testid="menu-user"
          >
            {authUser.name || authUser.email}
          </span>
        ) : null;
      case 'logout':
        return <BarButton key={id} {...common} testId="menu-logout" label="התנתק" icon={<IconLogout />} showLabel onClick={() => void signOut()} />;
    }
  };

  return (
    <header
      id="top-menu"
      data-testid="top-menu"
      data-open="true"
      data-compact={compact ? 'true' : 'false'}
      aria-label="סרגל כלים"
      dir="rtl"
      className="absolute inset-x-0 z-[44] border-b border-slate-700/80 bg-slate-800 text-slate-200 shadow-md shadow-black/30"
      style={{
        top: TABBAR_H,
        height: topMenuHeight(compact),
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        data-testid="menu-open-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onOpenFile(f);
          e.target.value = '';
        }}
      />
      <div
        ref={row}
        role="toolbar"
        aria-label="סרגל כלים"
        className="flex h-full flex-nowrap items-center gap-0.5 overflow-x-auto overflow-y-hidden px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {groups.map((g, i) => (
          <div key={g.id} className={'flex shrink-0 items-center' + (g.id === 'view' && !compact ? ' ms-auto' : '')}>
            {i > 0 && !(g.id === 'view' && !compact) && <Divider />}
            <div className="flex items-center gap-0.5" role="group" aria-label={g.label} data-group={g.id}>
              {g.items.map(render)}
            </div>
            {g.id === 'view' && !compact && i < groups.length - 1 && <Divider />}
          </div>
        ))}
      </div>
      <SaveAsToast />
    </header>
  );
}

/** Ctrl+Shift+S (⌘+Shift+S): Save As. Capture phase, so it wins over the tool shortcuts. */
function useSaveAsKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== 'KeyS') return;
      if (useViewer.getState().numPages === 0) return;
      e.preventDefault();
      e.stopPropagation();
      saveAsMarked();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/** Progress / result of Save As (bottom centre, above the dock). */
function SaveAsToast() {
  const status = useSaveAs((s) => s.status);
  useEffect(() => {
    if (status?.phase !== 'done') return;
    const t = window.setTimeout(dismissSaveAs, 6000);
    return () => window.clearTimeout(t);
  }, [status]);
  if (!status) return null;
  const tone =
    status.phase === 'error'
      ? 'border-red-800 bg-red-950/95 text-red-100'
      : status.phase === 'done'
        ? 'border-emerald-700 bg-emerald-950/95 text-emerald-100'
        : 'border-slate-600 bg-slate-800/95 text-slate-100';
  const size = status.phase === 'done' ? (status.bytes > 1024 * 1024 ? `${(status.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(status.bytes / 1024))} KB`) : '';
  return (
    <div
      role={status.phase === 'error' ? 'alert' : 'status'}
      data-testid="save-as-toast"
      data-phase={status.phase}
      style={{ bottom: 'calc(var(--bottom-slot-h, 0px) + 0.75rem)' }}
      className={`fixed left-1/2 z-[55] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-md border px-3 py-2 text-sm shadow-xl backdrop-blur ${tone}`}
    >
      {status.phase === 'running' && (
        <>
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-500 border-t-sky-400" aria-hidden="true" />
          <span className="min-w-0 truncate">
            שומר <span dir="auto">{status.name}</span> — {status.text}
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-slate-400" dir="ltr">
            {Math.round(status.frac * 100)}%
          </span>
          <button type="button" onClick={cancelSaveAs} className="shrink-0 rounded px-1.5 text-xs text-slate-300 hover:bg-slate-700 hover:text-white">
            ביטול
          </button>
        </>
      )}
      {status.phase === 'done' && (
        <span className="min-w-0 truncate">
          ✓ <span dir="auto">{status.name}</span> {status.how === 'download' ? 'הורד' : 'נשמר'} (<span dir="ltr">{size}</span>)
        </span>
      )}
      {status.phase === 'error' && <span className="min-w-0">{status.text}</span>}
      {status.phase !== 'running' && (
        <button type="button" onClick={dismissSaveAs} aria-label="סגור הודעה" className="shrink-0 rounded p-0.5 opacity-80 hover:opacity-100">
          <IconX size={14} />
        </button>
      )}
    </div>
  );
}
