/**
 * Content of the left drawer: the items table (טבלת פריטים). M opens / closes it.
 * (It used to have "מדידות" / "תמחור" tabs; the measurements list duplicated the items.)
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { useUi } from '../state/uiStore';
import { loadEditChrome } from '../components/shell/modeActions';

const ItemsPanel = lazy(() => import('../components/items/ItemsPanel'));

/** Toggle the left drawer (the items table). */
export function toggleLeftTab(_tab: 'items' = 'items') {
  const ui = useUi.getState();
  // The items table is an edit-mode panel: opening it from the clean view switches to edit mode.
  if (!ui.editMode) {
    void loadEditChrome();
    ui.setEditMode(true);
  }
  ui.setDrawerOpen('measurements', !useUi.getState().measurementsOpen || !ui.editMode);
}

export function LeftDrawerContent(props: { onHide: () => void; headerActions: ReactNode }) {
  return (
    <div className="flex min-h-0 max-w-full flex-col">
      <Suspense fallback={<div className="w-72 p-4 text-xs text-slate-400">טוען…</div>}>
        <ItemsPanel {...props} />
      </Suspense>
    </div>
  );
}
