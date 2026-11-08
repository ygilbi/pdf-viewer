import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { useZoom, viewerCommands } from '../viewer/commands';
import { ToolButton, ToolbarDivider } from '../ui/ToolButton';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFilePdf,
  IconFit,
  IconFolderOpen,
  IconFullscreen,
  IconFullscreenExit,
  IconCalculator,
  IconList,
  IconPages,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from '../ui/icons';
import { CopyTableButton } from '../CopyTableButton';
import { openExportDialog } from '../../export/exportUi';
import { ActiveCategorySelect } from '../CategorySelect';
import { fullscreenSupported, toggleFullscreen, useIsFullscreen } from '../toolActions';
import { InstallButton, currentOs, openDefaultAppDialog } from '../../pwa';
import { WINDOWS_DOWNLOAD_URL, showWindowsDownload } from '../../pwa/desktopDownload';
import { signOut, useAuthUser } from '../../auth/session';
import { toggleLeftTab } from '../../pricing/LeftDrawer';
import { usePricingUi } from '../../pricing/pricingUi';
import { DriveOpenButton } from '../../drive/DriveUi';
import { formatPaper } from '../../text/scaleDetect';
import { IconSearch, openSearch } from '../text/SearchPanel';
import { sendManualReport } from '../../diag/diagUi';

function Group({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/**
 * Slide-down top bar with everything that is not a drawing tool. Always
 * mounted (hidden when closed) so the copy-table toast / fallback survive
 * closing it; `inert` keeps it out of the tab order while hidden.
 */
export function TopMenu({ onOpenFile }: { onOpenFile(file: File): void }) {
  const open = useUi((s) => s.menuOpen);
  const setMenuOpen = useUi((s) => s.setMenuOpen);
  const thumbsOpen = useUi((s) => s.thumbsOpen);
  const measOpen = useUi((s) => s.measurementsOpen);
  const toggleDrawer = useUi((s) => s.toggleDrawer);
  const leftTab = usePricingUi((s) => s.tab);

  const fileName = useViewer((s) => s.fileName);
  const numPages = useViewer((s) => s.numPages);
  const currentPage = useViewer((s) => s.currentPage);
  const setPage = useViewer((s) => s.setPage);
  const setTool = useViewer((s) => s.setTool);
  const calibration = useViewer((s) => s.calibrations[s.currentPage]);
  const measurementCount = useViewer((s) => s.measurements.length);
  const zoom = useZoom().percent;
  const isFs = useIsFullscreen();
  const authUser = useAuthUser((s) => s.user);
  const hasDoc = numPages > 0;
  const paperLabel = formatPaper(useViewer((s) => s.pageSizes[s.currentPage - 1]));

  const ref = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Click outside closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t)) return;
      if (t.closest?.('[data-menu-toggle]') || t.closest?.('[role="dialog"]')) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, setMenuOpen]);

  // Move focus into the menu when it opens (keyboard users), back out when it closes.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    // Next frame: `inert` / visibility must be cleared before focus() is accepted.
    const raf = requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true }),
    );
    return () => {
      cancelAnimationFrame(raf);
      if (ref.current?.contains(document.activeElement)) prev?.focus?.({ preventScroll: true });
    };
  }, [open]);

  // null while not editing → the input mirrors currentPage.
  const [pageText, setPageText] = useState<string | null>(null);
  const commitPage = () => {
    if (pageText == null) return;
    const n = parseInt(pageText, 10);
    if (Number.isFinite(n)) setPage(n);
    setPageText(null);
  };

  return (
    <header
      ref={ref}
      id="top-menu"
      data-testid="top-menu"
      data-open={open ? 'true' : 'false'}
      aria-label="תפריט"
      aria-hidden={!open}
      inert={!open}
      className={
        'absolute inset-x-0 top-0 z-40 border-b border-slate-700/80 bg-slate-800/95 text-slate-200 shadow-xl shadow-black/40 backdrop-blur ' +
        'duration-200 ease-out motion-reduce:transition-none ' +
        // Opening: visible at once (so focus() works); closing: stay visible until the slide ends.
        (open ? 'visible translate-y-0 transition-transform' : 'invisible -translate-y-full transition-[transform,visibility]')
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            setMenuOpen(false);
            onOpenFile(f);
          }
          e.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-2 py-1.5">
        {/* file */}
        <Group label="קובץ">
          <ToolButton label="פתח קובץ (החלף)" onClick={() => fileInput.current?.click()} showLabel>
            <IconFolderOpen />
          </ToolButton>
          <DriveOpenButton variant="menu" onBeforeOpen={() => setMenuOpen(false)} />
          {fileName && (
            <div className="flex max-w-[14rem] items-center gap-1 truncate px-1 text-xs text-slate-400" title={fileName}>
              <IconFilePdf size={14} className="shrink-0 text-red-400" />
              <span className="truncate" dir="auto">
                {fileName}
              </span>
            </div>
          )}
        </Group>

        <ToolbarDivider />

        {/* pages */}
        <Group label="דפים">
          <ToolButton
            label="הדף הקודם"
            shortcut="PageUp"
            disabled={!hasDoc || currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            <IconChevronRight />
          </ToolButton>
          <div className="flex items-center gap-1 text-xs text-slate-400">
            <span>דף</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label="מספר דף"
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
              className="h-6 w-12 rounded border border-slate-600 bg-slate-900 text-center font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none disabled:opacity-40"
            />
            <span className="whitespace-nowrap">מתוך {hasDoc ? numPages : '—'}</span>
            {hasDoc && paperLabel && (
              <span className="whitespace-nowrap text-[11px] text-slate-500" title="גודל הגיליון לפי מידות הדף" data-testid="menu-paper">
                · {paperLabel}
              </span>
            )}
          </div>
          <ToolButton
            label="הדף הבא"
            shortcut="PageDown"
            disabled={!hasDoc || currentPage >= numPages}
            onClick={() => setPage(currentPage + 1)}
          >
            <IconChevronLeft />
          </ToolButton>
        </Group>

        <ToolbarDivider />

        {/* zoom */}
        <Group label="זום">
          <ToolButton label="הקטן" shortcut="-" disabled={!hasDoc} onClick={() => viewerCommands.zoomOut()}>
            <IconZoomOut />
          </ToolButton>
          <div className="w-12 text-center font-mono text-xs tabular-nums text-slate-300" aria-label="זום">
            {hasDoc ? `${Math.round(zoom)}%` : '—'}
          </div>
          <ToolButton label="הגדל" shortcut="+" disabled={!hasDoc} onClick={() => viewerCommands.zoomIn()}>
            <IconZoomIn />
          </ToolButton>
          <ToolButton label="התאם לדף" shortcut="0 / F" disabled={!hasDoc} onClick={() => viewerCommands.fit()}>
            <IconFit />
          </ToolButton>
        </Group>

        <ToolbarDivider />

        {/* calibration + category */}
        <Group label="כיול וקטגוריה">
          {hasDoc &&
            (calibration ? (
              <div
                className="flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-emerald-700/70 bg-emerald-900/40 px-2 text-[11px] text-emerald-300"
                title={
                  calibration.auto
                    ? `כיול אוטומטי לפי ${calibration.source ?? 'קנ״מ שבשרטוט'} (הדפסה ב‑100%) בדף ${currentPage} — מומלץ לאמת מול מידה ידועה`
                    : `כויל לפי ${calibration.meters} מ׳ בדף ${currentPage}`
                }
                data-testid="menu-calibration"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                {calibration.auto && calibration.source ? (
                  <>
                    קנ״מ <span dir="ltr">{calibration.source}</span> (אוטומטי)
                  </>
                ) : (
                  <>קנ״מ: 1 מ׳ = {calibration.pixelsPerMeter.toFixed(2)} יח׳</>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setTool('calibrate');
                  setMenuOpen(false);
                }}
                className="flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-amber-600/70 bg-amber-900/30 px-2 text-[11px] text-amber-300 hover:bg-amber-900/60"
                title="לחץ כדי לכייל את קנה המידה של הדף"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                לא מכויל
              </button>
            ))}
          <span className="w-1" />
          {hasDoc && <ActiveCategorySelect />}
        </Group>

        <ToolbarDivider />

        {/* text search */}
        <Group label="חיפוש">
          <ToolButton
            label="חיפוש וספירה"
            shortcut="F3"
            hint="חיפוש בטקסט השרטוט וספירת תגיות (W1, D2…)"
            disabled={!hasDoc}
            onClick={() => {
              setMenuOpen(false);
              openSearch();
            }}
            showLabel
          >
            <IconSearch />
          </ToolButton>
        </Group>

        <ToolbarDivider />

        {/* export */}
        <Group label="ייצוא">
          <ToolButton
            label="ייצוא"
            shortcut="E"
            hint="PDF או CSV — בחירת דפים, קבצים ותוכן"
            disabled={!hasDoc}
            onClick={() => {
              setMenuOpen(false);
              openExportDialog();
            }}
            showLabel
          >
            <IconDownload />
          </ToolButton>
          <CopyTableButton disabled={!hasDoc || measurementCount === 0} />
        </Group>

        <div className="flex-1" />

        {/* view */}
        <Group label="תצוגה">
          <ToolButton
            label="תצוגת דפים"
            shortcut="T"
            active={thumbsOpen}
            disabled={!hasDoc}
            onClick={() => toggleDrawer('thumbs')}
          >
            <IconPages />
          </ToolButton>
          <ToolButton
            label="רשימת מדידות"
            shortcut="M"
            active={measOpen && leftTab === 'measurements'}
            disabled={!hasDoc}
            onClick={() => toggleLeftTab('measurements')}
          >
            <IconList />
          </ToolButton>
          <ToolButton
            label="תמחור / כתב כמויות"
            shortcut="Q"
            hint="מחירון, פחת, הנחה ומע״מ — סה״כ חי"
            active={measOpen && leftTab === 'pricing'}
            disabled={!hasDoc}
            onClick={() => toggleLeftTab('pricing')}
          >
            <IconCalculator />
          </ToolButton>
          {fullscreenSupported() && (
            <ToolButton label={isFs ? 'צא ממסך מלא' : 'מסך מלא'} shortcut="Shift+F" active={isFs} onClick={toggleFullscreen}>
              {isFs ? <IconFullscreenExit /> : <IconFullscreen />}
            </ToolButton>
          )}
          {currentOs() !== 'other' && (
            <button
              type="button"
              data-testid="menu-default-app"
              title="הגדרת PDF Viewer כתוכנה שפותחת קובצי PDF במחשב"
              onClick={() => {
                setMenuOpen(false);
                openDefaultAppDialog();
              }}
              className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs text-slate-300 hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
            >
              <IconFilePdf size={14} className="text-red-400" />
              הגדר כברירת מחדל ל‑PDF
            </button>
          )}
          {showWindowsDownload() && (
            <a
              href={WINDOWS_DOWNLOAD_URL}
              data-testid="menu-download-windows"
              title="מתקין לשולחן העבודה של Windows"
              className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs text-sky-300 hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
            >
              הורד גרסת Windows
            </a>
          )}
          <button
            type="button"
            data-testid="menu-diag-report"
            title="שליחת נתונים טכניים על הפעולות האחרונות (ללא תוכן קבצים) כדי שנוכל לאתר תקלה"
            onClick={() => {
              setMenuOpen(false);
              sendManualReport();
            }}
            className="flex h-8 items-center whitespace-nowrap rounded px-2 text-xs text-slate-300 hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
          >
            שלח דוח תקלה
          </button>
          <InstallButton
            label="התקן"
            className="flex h-8 items-center gap-1.5 rounded px-2 text-xs text-sky-300 hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
          />
          {authUser && (
            <>
              <ToolbarDivider />
              <span className="max-w-[10rem] truncate px-1 text-xs text-slate-400" dir="auto" title={authUser.email} data-testid="menu-user">
                {authUser.name || authUser.email}
              </span>
              <button
                type="button"
                data-testid="menu-logout"
                onClick={() => void signOut()}
                className="flex h-8 items-center whitespace-nowrap rounded px-2 text-xs text-slate-300 hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
              >
                התנתק
              </button>
            </>
          )}
          <ToolbarDivider />
          <ToolButton label="סגור תפריט" shortcut="Esc" onClick={() => setMenuOpen(false)}>
            <IconX />
          </ToolButton>
        </Group>
      </div>
    </header>
  );
}
