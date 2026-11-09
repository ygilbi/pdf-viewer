import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { useSnap } from '../../state/snapStore';

/** Tools whose clicks snap to the drawing (keep in sync with ViewerCanvas isSnapTool). */
const SNAP_TOOLS = new Set<string>(['area', 'deduct', 'length', 'calibrate', 'rectArea', 'rectDeduct', 'count']);
import { useMarkup } from '../../state/markupStore';
import { useCountFlow } from '../../state/countFlow';
import { useSearch } from '../../text/searchStore';
import { kindOf } from '../../core/measurementEngine';
import { IconX } from '../ui/icons';
import { computeHint } from './hints';
import { useMedia } from './layout';

/** Small "?" (in the dock / edit toolbar) that shows the hints again after the user hid them. */
export function HintsToggle() {
  const hidden = useUi((s) => s.hintsHidden);
  const setHidden = useUi((s) => s.setHintsHidden);
  if (!hidden) return null;
  return (
    <button
      type="button"
      onClick={() => setHidden(false)}
      aria-label="הצג הנחיות"
      title="הצג הנחיות"
      data-testid="hint-show"
      className="flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-full border border-slate-600/70 text-xs font-bold text-slate-400 hover:bg-slate-800 hover:text-white"
    >
      ?
    </button>
  );
}

/**
 * AutoCAD-style command prompt: what to do in the current step (derived from the active tool /
 * draft / count flow / editing state) and the keys that apply. Lives in the bottom slot, right
 * above the dock / edit toolbar, so it never collides with them or with "סיום" / "חזור".
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
  const editMode = useUi((s) => s.editMode);
  const hidden = useUi((s) => s.hintsHidden);
  const setHidden = useUi((s) => s.setHintsHidden);

  const touch = useMedia('(pointer: coarse)');
  const narrow = !useMedia('(min-width: 768px)');

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
    clean: !editMode,
  });

  // A phone-width drawer covers the bottom: hide (the drawer is what the user is looking at).
  if (drawerOpen && narrow) return null;
  // Shown even when the user hid hints: the count-measure step (skip button) and snapping switched off.
  const forced = hint?.action === 'countSkip' || (!snapEnabled && SNAP_TOOLS.has(tool));
  // Hidden: the "?" that brings them back sits in the dock / edit toolbar (HintsToggle).
  if (hidden && !forced) return null;
  if (!hint) return null;

  return (
    <div
      dir="rtl"
      role="status"
      aria-live="polite"
      data-testid="hint-panel"
      data-viewer-ui
      className={
        'pointer-events-none w-max max-w-[min(420px,calc(100vw-1rem))] rounded-md border bg-slate-950/80 px-2 py-1 shadow-lg shadow-black/30 backdrop-blur-sm ' +
        'text-[12px] leading-snug text-slate-300 [@media(pointer:coarse)]:text-[11.5px] ' +
        (hint.action ? 'border-violet-400/70' : hint.warn ? 'border-amber-500/60' : 'border-slate-600/60')
      }
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
          {!snapEnabled && SNAP_TOOLS.has(tool) && (
            <div className="pointer-events-auto mt-1 flex flex-wrap items-center gap-1.5 text-amber-300" data-testid="hint-snap-off">
              <span>ההצמדה לפינות ולאמצעים כבויה</span>
              <button
                type="button"
                onClick={() => useSnap.getState().setEnabled(true)}
                data-testid="hint-snap-on"
                className="rounded bg-amber-500 px-2 py-0.5 text-[11px] font-semibold text-slate-900 hover:bg-amber-400 [@media(pointer:coarse)]:px-3 [@media(pointer:coarse)]:py-1"
              >
                הפעל הצמדה
              </button>
            </div>
          )}
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
            onClick={() => setHidden(true)}
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
