/**
 * Content of the left drawer: tabs "מדידות" | "תמחור". M / Q open the drawer
 * on the respective tab (pressing the key of the visible tab closes it).
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { useUi } from '../state/uiStore';
import MeasurementsPanel from '../components/MeasurementsPanel';
import { usePricingUi, type LeftTab } from './pricingUi';

const PricingPanel = lazy(() => import('./PricingPanel'));
const ItemsPanel = lazy(() => import('../components/items/ItemsPanel'));

/** Toggle the left drawer on `tab` (switches tab when the drawer shows the other one). */
export function toggleLeftTab(tab: LeftTab) {
  const ui = useUi.getState();
  const p = usePricingUi.getState();
  if (ui.measurementsOpen && p.tab === tab) ui.setDrawerOpen('measurements', false);
  else {
    p.setTab(tab);
    ui.setDrawerOpen('measurements', true);
  }
}

const TABS: { id: LeftTab; label: string; key: string }[] = [
  { id: 'measurements', label: 'מדידות', key: 'M' },
  { id: 'items', label: 'פריטים', key: '' },
  { id: 'pricing', label: 'תמחור', key: 'Q' },
];

export function LeftDrawerContent(props: { onHide: () => void; headerActions: ReactNode }) {
  const tab = usePricingUi((s) => s.tab);
  const setTab = usePricingUi((s) => s.setTab);
  return (
    <div className="flex min-h-0 max-w-full flex-col">
      <div role="tablist" aria-label="חלונית" className="flex shrink-0 border-b border-slate-700 bg-slate-900/80 text-xs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`left-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            title={t.key ? `${t.label} (${t.key})` : t.label}
            className={
              'flex-1 px-3 py-1.5 transition-colors ' +
              (tab === t.id ? 'border-b-2 border-sky-500 font-semibold text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200')
            }
          >
            {t.label} {t.key && <kbd className="ms-1 rounded bg-slate-700/70 px-1 font-mono text-[10px] text-slate-400">{t.key}</kbd>}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        {tab === 'items' ? (
          <Suspense fallback={<div className="w-72 p-4 text-xs text-slate-400">טוען…</div>}>
            <ItemsPanel {...props} />
          </Suspense>
        ) : tab === 'pricing' ? (
          <Suspense fallback={<div className="w-72 p-4 text-xs text-slate-400">טוען…</div>}>
            <PricingPanel {...props} />
          </Suspense>
        ) : (
          <MeasurementsPanel {...props} />
        )}
      </div>
    </div>
  );
}
