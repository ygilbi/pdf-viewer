import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useViewer } from '../../state/store';
import { buildItemTable, formatSubtotal, isItem, type ItemRow } from '../../core/itemTable';
import { KIND_LABELS, kindOf, takeoffOnly } from '../../core/measurementEngine';
import { MeasurementCategorySelect } from '../CategorySelect';
import { startNewCountItem } from '../shell/CountFinishButton';
import { openExportDialog } from '../../export/exportUi';
import type { AreaMeasurement } from '../../core/types';

type TextField = 'itemName' | 'system' | 'sizeText' | 'qtyText' | 'extra';

function useWide(): boolean {
  const q = '(min-width: 768px)';
  const [wide, setWide] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(q);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** Free-text cell: shows the user's text, or the automatic value as a grey hint. */
function Cell({
  m,
  field,
  value,
  custom,
  label,
  className = '',
  multiline = false,
  dir,
}: {
  m: string;
  field: TextField;
  value: string;
  custom: boolean;
  label: string;
  className?: string;
  multiline?: boolean;
  dir?: 'ltr' | 'rtl';
}) {
  const stored = useViewer((s) => {
    const x = s.measurements.find((y) => y.id === m);
    return (x?.[field] as string | undefined) ?? '';
  });
  const common = {
    value: stored,
    dir,
    placeholder: custom ? '' : value || label,
    'aria-label': label,
    title: !custom && value ? `אוטומטי: ${value}` : label,
    'data-testid': `item-${field}`,
    onChange: (e: { target: { value: string } }) => useViewer.getState().updateMeasurement(m, { [field]: e.target.value || undefined }),
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    className:
      'w-full min-w-0 rounded border border-transparent bg-slate-900/60 px-1.5 py-1 text-[13px] text-slate-100 placeholder:text-slate-500 hover:border-slate-600 focus:border-sky-500 focus:outline-none ' +
      className,
  };
  return multiline ? <textarea rows={1} {...common} style={{ resize: 'vertical' }} /> : <input type="text" {...common} />;
}

function goTo(r: ItemRow) {
  const s = useViewer.getState();
  if (s.currentPage !== r.page) s.setPage(r.page);
  s.select(r.id);
}

function RowActions({ r }: { r: ItemRow }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={() => goTo(r)}
        title={`הצג בשרטוט (עמוד ${r.page})`}
        className="rounded px-1.5 py-1 text-[11px] text-sky-300 hover:bg-slate-700"
      >
        עמ׳ {r.page}
      </button>
      {r.kind !== 'count' && (
        <button
          type="button"
          onClick={() => useViewer.getState().updateMeasurement(r.id, { asItem: undefined })}
          title="הוצא מטבלת הפריטים (המדידה נשארת)"
          aria-label="הוצא מהטבלה"
          className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-700 hover:text-red-300"
        >
          ×
        </button>
      )}
    </div>
  );
}

export default function ItemsPanel({ headerActions }: { onHide?: () => void; headerActions?: ReactNode }) {
  const measurements = useViewer((s) => s.measurements);
  const calibrations = useViewer((s) => s.calibrations);
  const categories = useViewer((s) => s.categories);
  const wide = useWide();
  const table = useMemo(() => buildItemTable(measurements, calibrations, categories), [measurements, calibrations, categories]);
  const candidates = useMemo(
    () => takeoffOnly(measurements).filter((m: AreaMeasurement) => (kindOf(m) === 'area' || kindOf(m) === 'length') && !isItem(m)),
    [measurements],
  );
  const rowsCount = table.groups.reduce((a, g) => a + g.rows.length, 0);

  return (
    <section
      dir="rtl"
      data-testid="items-panel"
      className="flex min-h-0 w-[min(64rem,calc(100vw-3rem))] flex-col bg-slate-800/80 text-slate-200"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-700 px-2 py-1.5 text-[11px]">
        <span className="text-sm font-semibold text-slate-100">טבלת פריטים</span>
        <span className="text-slate-500">({rowsCount})</span>
        <button
          type="button"
          onClick={startNewCountItem}
          data-testid="items-new-count"
          className="whitespace-nowrap rounded border border-emerald-700/70 bg-emerald-900/30 px-1.5 py-0.5 font-semibold text-emerald-300 hover:bg-emerald-800/50 hover:text-white"
        >
          + פריט חדש
        </button>
        {candidates.length > 0 && (
          <select
            value=""
            data-testid="items-add-area"
            aria-label="הוסף שטח או אורך מדוד כפריט"
            onChange={(e) => e.target.value && useViewer.getState().updateMeasurement(e.target.value, { asItem: true })}
            className="max-w-[12rem] rounded border border-slate-600 bg-slate-900 px-1 py-0.5 text-[11px] text-slate-200"
          >
            <option value="">+ שטח / אורך כפריט…</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {KIND_LABELS[kindOf(m)]} · עמ׳ {m.page}
              </option>
            ))}
          </select>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => openExportDialog('pdf')}
          className="whitespace-nowrap rounded bg-sky-700 px-2 py-0.5 font-semibold text-white hover:bg-sky-600"
        >
          ייצוא
        </button>
        {headerActions}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rowsCount === 0 ? (
          <div className="space-y-2 p-4 text-sm leading-relaxed text-slate-400">
            <p>אין עדיין פריטים.</p>
            <p>• פריטים נספרים (חלונות, דלתות…) נוצרים בכלי הספירה — "+ פריט חדש".</p>
            <p>• שטח מדוד (למשל קיר מסך) נכנס לטבלה דרך "+ שטח / אורך כפריט", או בכפתור "כפריט" ברשימת המדידות.</p>
          </div>
        ) : wide ? (
          <table className="w-full border-collapse text-[13px]">
            <thead className="sticky top-0 z-10 bg-slate-900 text-[11px] text-slate-400">
              <tr>
                {['שם פריט', 'קטגוריה', 'מערכת', 'גודל', 'כמות', 'מידע נוסף', ''].map((h, i) => (
                  <th key={i} className="border-b border-slate-700 px-1.5 py-1 text-start font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            {table.groups.map((g) => (
              <tbody key={g.key} data-testid="items-group">
                {g.rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-700/60 align-top" data-testid="items-row">
                    <td className="w-[16%] p-1"><Cell m={r.id} field="itemName" value={r.name} custom={r.custom.name} label="שם פריט" /></td>
                    <td className="w-[13%] p-1"><MeasurementCategorySelect id={r.id} value={r.categoryKey} /></td>
                    <td className="w-[16%] p-1"><Cell m={r.id} field="system" value={r.system} custom={!!r.system} label="מערכת" /></td>
                    <td className="w-[11%] p-1"><Cell m={r.id} field="sizeText" value={r.size} custom={r.custom.size} label="גודל" className="text-center" dir="ltr" /></td>
                    <td className="w-[11%] p-1"><Cell m={r.id} field="qtyText" value={r.qtyText} custom={r.custom.qty} label="כמות" className="text-center" /></td>
                    <td className="p-1"><Cell m={r.id} field="extra" value={r.extra} custom={r.custom.extra} label="מידע נוסף" multiline /></td>
                    <td className="w-px p-1"><RowActions r={r} /></td>
                  </tr>
                ))}
                <tr className="bg-slate-900/80 font-semibold text-sky-200" data-testid="items-subtotal">
                  <td className="px-2 py-1.5" colSpan={4}>
                    <span className="me-1.5 inline-block h-2.5 w-2.5 rounded-full border border-slate-500 align-middle" style={{ background: g.color ?? 'transparent' }} />
                    סה״כ {g.name}
                  </td>
                  <td className="px-2 py-1.5 text-center font-mono tabular-nums" colSpan={3}>
                    {formatSubtotal(g.subtotal)}
                  </td>
                </tr>
              </tbody>
            ))}
          </table>
        ) : (
          <div className="space-y-3 p-2">
            {table.groups.map((g) => (
              <div key={g.key} data-testid="items-group">
                {g.rows.map((r) => (
                  <div key={r.id} className="mb-2 space-y-1 rounded-lg border border-slate-700 bg-slate-900/40 p-2" data-testid="items-row">
                    <div className="flex items-center gap-1">
                      <Cell m={r.id} field="itemName" value={r.name} custom={r.custom.name} label="שם פריט" className="font-semibold" />
                      <RowActions r={r} />
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      <MeasurementCategorySelect id={r.id} value={r.categoryKey} />
                      <Cell m={r.id} field="system" value={r.system} custom={!!r.system} label="מערכת" />
                      <Cell m={r.id} field="sizeText" value={r.size} custom={r.custom.size} label="גודל" dir="ltr" />
                      <Cell m={r.id} field="qtyText" value={r.qtyText} custom={r.custom.qty} label="כמות" />
                    </div>
                    <Cell m={r.id} field="extra" value={r.extra} custom={r.custom.extra} label="מידע נוסף" multiline />
                  </div>
                ))}
                <div className="flex items-center justify-between rounded-lg bg-slate-900/80 px-2 py-1.5 text-xs font-semibold text-sky-200" data-testid="items-subtotal">
                  <span>
                    <span className="me-1.5 inline-block h-2.5 w-2.5 rounded-full border border-slate-500 align-middle" style={{ background: g.color ?? 'transparent' }} />
                    סה״כ {g.name}
                  </span>
                  <span className="font-mono tabular-nums">{formatSubtotal(g.subtotal)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {rowsCount > 0 && (
          <div className="sticky bottom-0 flex items-center justify-between border-t border-slate-700 bg-slate-900 px-2 py-1.5 text-xs font-bold text-white" data-testid="items-total">
            <span>סה״כ כללי</span>
            <span className="font-mono tabular-nums">{formatSubtotal(table.total)}</span>
          </div>
        )}
        {table.uncalibrated > 0 && (
          <div className="p-2 text-[11px] text-amber-400">{table.uncalibrated} פריטים בדפים לא מכוילים — הכמות שלהם לא נספרת בסיכום.</div>
        )}
      </div>
    </section>
  );
}
