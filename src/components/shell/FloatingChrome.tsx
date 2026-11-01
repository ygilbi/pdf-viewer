import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { useZoom, viewerCommands } from '../viewer/commands';
import { IconList, IconMenu, IconPages } from '../ui/icons';
import { TOOLS } from '../toolActions';

const IDLE_MS = 2500;
/** Pointer moves within this many px of the top edge wake the controls. */
const WAKE_ZONE_PX = 96;

/**
 * Auto-hiding chrome: wakes on pointer movement near the top, on any key,
 * and while hovered/focused; fades to low opacity after IDLE_MS.
 * State lives here so waking never re-renders anything else.
 */
function useAwake(hold: boolean) {
  const [awake, setAwake] = useState(true);
  const hovering = useRef(false);
  const timer = useRef(0);
  const holdRef = useRef(hold);
  holdRef.current = hold;

  const wake = useRef(() => {});
  wake.current = () => {
    setAwake(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!hovering.current && !holdRef.current) setAwake(false);
    }, IDLE_MS);
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.clientY <= WAKE_ZONE_PX) wake.current();
    };
    const onKey = () => wake.current();
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onMove, { passive: true });
    window.addEventListener('keydown', onKey);
    wake.current();
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!hold) wake.current(); // restart the idle timer when the hold ends
  }, [hold]);

  const bind = {
    onPointerEnter: () => {
      hovering.current = true;
      wake.current();
    },
    onPointerLeave: () => {
      hovering.current = false;
      wake.current();
    },
    onFocus: () => {
      hovering.current = true;
      wake.current();
    },
    onBlur: () => {
      hovering.current = false;
      wake.current();
    },
  };
  return { awake: awake || hold, bind };
}

const fadeCls = (awake: boolean) =>
  'transition-opacity motion-reduce:transition-none ' + (awake ? 'opacity-100 duration-150' : 'opacity-25 duration-700');

const chipBtn =
  'flex h-8 min-w-8 items-center justify-center gap-1 rounded-full px-2 text-xs text-slate-200 transition-colors ' +
  'hover:bg-slate-700/80 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400';

/** Translucent status pill (top-centre) + the two drawer edge handles. */
export function FloatingChrome() {
  const menuOpen = useUi((s) => s.menuOpen);
  const thumbsOpen = useUi((s) => s.thumbsOpen);
  const measOpen = useUi((s) => s.measurementsOpen);
  const setMenuOpen = useUi((s) => s.setMenuOpen);
  const toggleDrawer = useUi((s) => s.toggleDrawer);

  const numPages = useViewer((s) => s.numPages);
  const currentPage = useViewer((s) => s.currentPage);
  // Multi-file workspace: "file · local/total" (null with a single file).
  const fileDoc = useViewer((s) =>
    s.docs.length > 1 ? s.docs.find((d) => s.currentPage > d.pageOffset && s.currentPage <= d.pageOffset + d.numPages) : undefined,
  );
  const tool = useViewer((s) => s.tool);
  const setTool = useViewer((s) => s.setTool);
  const calibrated = useViewer((s) => !!s.calibrations[s.currentPage]);
  const measurementCount = useViewer((s) => s.measurements.length);
  const zoom = useZoom().percent;

  const { awake, bind } = useAwake(menuOpen);
  const t = TOOLS.find((x) => x.id === tool) ?? TOOLS[0];
  const fade = fadeCls(awake);

  return (
    <>
      {/* status pill */}
      <div
        {...bind}
        data-testid="floating-pill"
        data-awake={awake ? 'true' : 'false'}
        className={
          'absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-slate-600/70 ' +
          'bg-slate-900/75 p-0.5 shadow-lg shadow-black/40 backdrop-blur ' +
          fade
        }
      >
        <button
          type="button"
          data-menu-toggle
          aria-label="תפריט"
          aria-expanded={menuOpen}
          aria-controls="top-menu"
          title="תפריט"
          onClick={() => setMenuOpen(!menuOpen)}
          className={chipBtn}
        >
          <IconMenu />
        </button>
        <span className="mx-0.5 h-4 w-px bg-slate-600" aria-hidden="true" />
        <span
          className="flex h-8 items-center gap-1 rounded-full bg-sky-600/90 px-2 text-xs text-white"
          title={`${t.label} (${t.shortcut})`}
          data-testid="pill-tool"
        >
          {t.icon}
          <span className="hidden whitespace-nowrap sm:inline">{t.label}</span>
        </span>
        <button
          type="button"
          data-drawer-toggle="thumbs"
          onClick={() => toggleDrawer('thumbs')}
          title="דפים (T)"
          aria-label={
            fileDoc
              ? `${fileDoc.name}, דף ${currentPage - fileDoc.pageOffset} מתוך ${fileDoc.numPages} (דף ${currentPage} מתוך ${numPages} בסך הכול)`
              : `דף ${currentPage} מתוך ${numPages}`
          }
          className={chipBtn + ' font-mono tabular-nums'}
          data-testid="pill-page"
        >
          {fileDoc && (
            <>
              <span className="max-w-[9rem] truncate font-sans text-slate-400" dir="auto" title={fileDoc.name} data-testid="pill-file">
                {fileDoc.name.replace(/\.pdf$/i, '')}
              </span>
              <span className="text-slate-500" aria-hidden="true">
                ·
              </span>
            </>
          )}
          <span dir="ltr">
            {fileDoc ? currentPage - fileDoc.pageOffset : currentPage} / {fileDoc ? fileDoc.numPages : numPages}
          </span>
        </button>
        <button
          type="button"
          onClick={() => viewerCommands.fit()}
          title="זום — לחץ להתאמה לדף (0)"
          aria-label={`זום ${Math.round(zoom)}%, התאם לדף`}
          className={chipBtn + ' w-14 font-mono tabular-nums'}
          data-testid="pill-zoom"
        >
          <span dir="ltr">{Math.round(zoom)}%</span>
        </button>
        {!calibrated && (
          <button
            type="button"
            onClick={() => setTool('calibrate')}
            className="me-0.5 flex h-7 items-center gap-1 whitespace-nowrap rounded-full border border-amber-600/70 bg-amber-900/40 px-2 text-[11px] text-amber-300 hover:bg-amber-900/70"
            title="הדף לא מכויל — לחץ כדי לכייל (C)"
            data-testid="pill-calibrate"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            לא מכויל
          </button>
        )}
      </div>

      {/* drawer handles (RTL: thumbnails on the start/right side, measurements on the left) */}
      {!thumbsOpen && (
        <button
          {...bind}
          type="button"
          data-drawer-toggle="thumbs"
          data-testid="handle-thumbs"
          onClick={() => toggleDrawer('thumbs')}
          aria-label="תצוגת דפים (T)"
          title="תצוגת דפים (T)"
          className={
            'absolute right-2 top-2 z-20 flex h-9 w-9 items-center justify-center rounded-lg border border-slate-600/70 bg-slate-900/75 ' +
            'text-slate-300 shadow-lg backdrop-blur hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 ' +
            fade
          }
        >
          <IconPages />
        </button>
      )}
      {!measOpen && (
        <button
          {...bind}
          type="button"
          data-drawer-toggle="measurements"
          data-testid="handle-measurements"
          onClick={() => toggleDrawer('measurements')}
          aria-label="רשימת מדידות (M)"
          title="רשימת מדידות (M)"
          className={
            'absolute left-2 top-2 z-20 flex h-9 w-9 items-center justify-center rounded-lg border border-slate-600/70 bg-slate-900/75 ' +
            'text-slate-300 shadow-lg backdrop-blur hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 ' +
            fade
          }
        >
          <IconList />
          {measurementCount > 0 && (
            <span className="absolute -right-1 -top-1 min-w-[1rem] rounded-full bg-sky-600 px-1 text-center text-[9px] leading-4 text-white">
              {measurementCount}
            </span>
          )}
        </button>
      )}
    </>
  );
}
