import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { kindOf } from '../../core/measurementEngine';
import { useCountFlow } from '../../state/countFlow';

/** Finish the count group being marked: the next tap starts a new item (פריט 2, 3…). */
export function finishCountItem(): void {
  const s = useViewer.getState();
  if (s.selectedId) s.select(null);
}

/** "+ פריט חדש" (measurements panel): switch to the count tool with no group selected. */
export function startNewCountItem(): void {
  const s = useViewer.getState();
  s.select(null);
  if (s.tool !== 'count') s.setTool('count');
  // On a phone the drawer covers the drawing; close it unless pinned so the user can tap.
  const ui = useUi.getState();
  if (!ui.measurementsPinned) ui.setDrawerOpen('measurements', false);
}

/** Small floating "סיום" while a count group is being marked. */
export function CountFinishButton() {
  // Primitive selector (a fresh object per call would re-render forever under useSyncExternalStore).
  const label = useViewer((s) => {
    if (s.tool !== 'count' || !s.selectedId) return null;
    const m = s.measurements.find((x) => x.id === s.selectedId && x.page === s.currentPage);
    return m && kindOf(m) === 'count' ? m.label : null;
  });
  const active = label === null ? null : { label };
  const measuring = useCountFlow((f) => f.measuringId !== null);
  if (!active) return null;
  return (
    <>
    {measuring && (
      <div className="pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center px-3" data-viewer-ui>
        <div
          dir="rtl"
          data-testid="count-measure-banner"
          className="pointer-events-auto flex items-center gap-2 rounded-xl bg-violet-600 px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-black/40 ring-2 ring-white/70"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="6" width="16" height="12" rx="1" />
            <circle cx="4" cy="6" r="1.6" fill="currentColor" />
            <circle cx="20" cy="18" r="1.6" fill="currentColor" />
          </svg>
          <span>מדוד את {active.label}: שתי פינות נגדיות</span>
          <button
            type="button"
            onClick={() => useCountFlow.getState().done()}
            data-testid="count-measure-skip"
            className="rounded-lg bg-white/20 px-2 py-0.5 text-xs font-semibold hover:bg-white/30"
          >
            דלג
          </button>
        </div>
      </div>
    )}
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center px-4" data-viewer-ui>
      <button
        type="button"
        dir="rtl"
        onClick={finishCountItem}
        data-testid="count-finish"
        title={`סיים את ${active.label} ועבור לפריט הבא (Enter)`}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-black/40 ring-2 ring-white/80 transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-4 focus-visible:ring-sky-400 active:scale-95"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12.5 10 17 19 7" />
        </svg>
        סיום
      </button>
    </div>
    </>
  );
}
