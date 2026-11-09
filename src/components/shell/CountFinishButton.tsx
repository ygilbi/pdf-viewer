import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { kindOf } from '../../core/measurementEngine';

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
  if (!active) return null;
  // The count-measure step ("מדוד את …" + דלג) is explained in the HintPanel (bottom slot).
  return (
    // Rendered inside the bottom slot (stacked above the dock / edit toolbar, never over it).
    <div className="pointer-events-none flex justify-center" data-viewer-ui>
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
  );
}
