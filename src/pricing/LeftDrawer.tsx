/**
 * Content of the left drawer: the items table (טבלת פריטים). M opens / closes it.
 * (It used to have "מדידות" / "תמחור" tabs; the measurements list duplicated the items.)
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { useUi } from '../state/uiStore';
import { itemsTableAvailable } from '../state/editMode';

const ItemsPanel = lazy(() => import('../components/items/ItemsPanel'));

/** Toggle the left drawer (the items table). Edit mode only: in the clean view mode it does nothing. */
export function toggleLeftTab(_tab: 'items' = 'items') {
  const ui = useUi.getState();
  if (!itemsTableAvailable(ui)) return;
  ui.setDrawerOpen('measurements', !ui.measurementsOpen);
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
