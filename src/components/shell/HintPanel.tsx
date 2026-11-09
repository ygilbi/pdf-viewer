import { useEffect, useState, useSyncExternalStore } from 'react';
import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { useSnap } from '../../state/snapStore';
import { useMarkup } from '../../state/markupStore';
import { useCountFlow } from '../../state/countFlow';
import { useLinkHistory } from '../../state/linkHistory';
import { useSearch } from '../../text/searchStore';
import { kindOf } from '../../core/measurementEngine';
import { IconX } from '../ui/icons';
import { computeHint } from './hints';

const KEY = 'aluminum-hints-v1';
/** Below this width a bottom-centre button ("סיום" / "חזור") would collide with the panel. */
const NARROW_PX = 768;

function loadHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === '0';
  } catch {
    return false;
  }
}
function saveHidden(hidden: boolean) {
  try {
    localStorage.setItem(KEY, hidden ? '0' : '1');
  } catch {
    /* per-viewer convenience only */
  }
}

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia !== 'function') return () => {};
      const mq = matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
    () => false,
  );
}

/** Right edge (px, relative to the viewer region) of the open left drawer; 0 when closed. */
function useLeftDrawerEdge(open: boolean): number {
  const [edge, setEdge] = useState(0);
  useEffect(() => {
    if (!open) {
      setEdge(0);
      return;
    }
    let ro: ResizeObserver | null = null;
    let raf = 0;
    const attach = () => {
      const el = document.querySelector<HTMLElement>('[data-testid="drawer-measurements"]');
      if (!el) {
        raf = requestAnimationFrame(attach);
        return;
      }
      const upd = () => setEdge(el.offsetWidth);
      upd();
      ro = new ResizeObserver(upd);
      ro.observe(el);
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [open]);
  return edge;
}

/** Left edge (px, viewport) of the tool palette, so the panel can stop short of it on phones. */
function usePaletteLeft(): number {
  const [left, setLeft] = useState(Infinity);
  const thumbsOpen = useUi((s) => s.thumbsOpen);
  const collapsed = useUi((s) => s.paletteCollapsed);
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="tool-palette"]');
    if (!el) return;
    const upd = () => setLeft(el.getBoundingClientRect().left);
    upd();
    const t = window.setTimeout(upd, 260); // after the palette's slide transition
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    window.addEventListener('resize', upd);
    return () => {
      window.clearTimeout(t);
      ro.disconnect();
      window.removeEventListener('resize', upd);
    };
  }, [thumbsOpen, collapsed]);
  return left;
}

/**
 * AutoCAD-style command prompt in the bottom-left corner: what to do in the current step
 * (derived from the active tool / draft / count flow / editing state) and the keys that apply.
 * The container never takes pointer events; only its own buttons do.
 */
export function HintPanel() {
  const tool = useViewer((s) => s.tool);
  const draftLength = useViewer((s) => s.draft.length);
  const calibrated = useViewer((s) => !!s.calibrations[s.currentPage]?.pixelsPerMeter);
  const selectedLabel = useViewer((s) => {
    if (!s.selectedId) return null;
    const m = s.measurements.find((x) => x.id === s.selectedId && x.page === s.currentPage);
    return m ? m.label : null;
  });
  const activeCountLabel = useViewer((s) => {
    if (s.tool !== 'count' || !s.selectedId) return null;
    const m = s.measurements.find((x) => x.id === s.selectedId && x.page === s.currentPage);
    return m && kindOf(m) === 'count' ? m.label : null;
  });
  const measuringId = useCountFlow((f) => f.measuringId);
  const countMeasuringLabel = useViewer((s) => (measuringId ? (s.measurements.find((x) => x.id === measuringId)?.label ?? null) : null));
  const editingId = useMarkup((m) => m.editingId);
  const editingKind = useViewer((s) => (editingId ? (s.measurements.find((x) => x.id === editingId)?.kind ?? 'text') : null));
  const snapEnabled = useSnap((s) => s.enabled);
  const searchOpen = useSearch((s) => s.open);
  const drawerOpen = useUi((s) => s.measurementsOpen);
  const currentPage = useViewer((s) => s.currentPage);
  const linkTop = useLinkHistory((h) => h.hops[h.hops.length - 1]);
  const linkBack = !!linkTop && linkTop.to === currentPage;

  const touch = useMedia('(pointer: coarse)');
  const narrow = !useMedia(`(min-width: ${NARROW_PX}px)`);
  const drawerEdge = useLeftDrawerEdge(drawerOpen);
  const paletteLeft = usePaletteLeft();
  const [hidden, setHidden] = useState(loadHidden);

  const hint = computeHint({
    tool,
    draftLength,
    calibrated,
    touch,
    snapEnabled,
    countMeasuringLabel,
    activeCountLabel,
    selectedLabel,
    editingKind,
    searchOpen,
  });

  // A phone-width drawer covers the corner: hide (the drawer is what the user is looking at).
  if (drawerOpen && narrow) return null;
  // The count-measure step carries its skip button here, so it shows even when hints are off.
  const forced = hint?.action === 'countSkip';
  const bottomButton = activeCountLabel !== null || linkBack;
  const left = (drawerOpen ? drawerEdge : 0) + 8;
  const style = {
    left,
    // Never run under the tool palette (wide labelled palette on a phone).
    maxWidth: Number.isFinite(paletteLeft) ? Math.max(150, Math.min(280, paletteLeft - left - 8)) : undefined,
    bottom: narrow && bottomButton ? 'calc(4.75rem + env(safe-area-inset-bottom, 0px))' : 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',
  };

  if (hidden && !forced) {
    return (
      <div className="pointer-events-none absolute z-30" style={style} data-viewer-ui>
        <button
          type="button"
          onClick={() => {
            setHidden(false);
            saveHidden(false);
          }}
          aria-label="הצג הנחיות"
          title="הצג הנחיות"
          data-testid="hint-show"
          className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full border border-slate-600/70 bg-slate-900/70 text-xs font-bold text-slate-300 shadow backdrop-blur hover:bg-slate-800 hover:text-white"
        >
          ?
        </button>
      </div>
    );
  }
  if (!hint) return null;

  return (
    <div
      dir="rtl"
      role="status"
      aria-live="polite"
      data-testid="hint-panel"
      data-viewer-ui
      className={
        'pointer-events-none absolute z-30 max-w-[min(280px,calc(100vw-1rem))] rounded-md border bg-slate-950/75 px-2 py-1 shadow-lg shadow-black/30 backdrop-blur-sm ' +
        'text-[12px] leading-snug text-slate-300 [@media(pointer:coarse)]:max-w-[min(250px,calc(100vw-1rem))] [@media(pointer:coarse)]:text-[11.5px] ' +
        (hint.action ? 'border-violet-400/70' : hint.warn ? 'border-amber-500/60' : 'border-slate-600/60')
      }
      style={style}
    >
      <div className="flex items-start gap-1.5">
        <span className={'mt-px shrink-0 font-mono text-[11px] ' + (hint.warn ? 'text-amber-400' : hint.action ? 'text-violet-300' : 'text-sky-400')} aria-hidden="true">
          ›
        </span>
        <div className="min-w-0 flex-1" data-testid={hint.action === 'countSkip' ? 'count-measure-banner' : undefined}>
          <div className={'font-semibold ' + (hint.warn ? 'text-amber-300' : 'text-slate-100')} data-testid="hint-title">
            {hint.title}
          </div>
          {hint.lines.map((l) => (
            <div key={l} className="text-[11px] text-slate-400">
              {l}
            </div>
          ))}
          {hint.action === 'countSkip' && (
            <button
              type="button"
              onClick={() => useCountFlow.getState().done()}
              data-testid="count-measure-skip"
              className="pointer-events-auto mt-1 rounded bg-violet-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-violet-500 [@media(pointer:coarse)]:px-3 [@media(pointer:coarse)]:py-1"
            >
              דלג על המדידה
            </button>
          )}
        </div>
        {!forced && (
          <button
            type="button"
            onClick={() => {
              setHidden(true);
              saveHidden(true);
            }}
            aria-label="הסתר הנחיות"
            title="הסתר הנחיות (אפשר להחזיר ב־?)"
            data-testid="hint-close"
            className="pointer-events-auto -me-1 -mt-0.5 shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-800 hover:text-white"
          >
            <IconX size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
