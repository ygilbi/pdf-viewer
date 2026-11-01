import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useViewer } from '../state/store';
import type { AreaMeasurement, Calibration } from '../core/types';
import { formatArea, formatLength, polygonAreaM2, polygonPerimeterMeters } from '../core/measurementEngine';
import { IconList, IconTrash } from './ui/icons';

interface RowProps {
  m: AreaMeasurement;
  calibration: Calibration | undefined;
  selected: boolean;
  showPage: boolean;
  onSelect(m: AreaMeasurement): void;
  onRename(id: string, label: string): void;
  onDelete(id: string): void;
}

const Row = memo(function Row({ m, calibration, selected, showPage, onSelect, onRename, onDelete }: RowProps) {
  const [label, setLabel] = useState(m.label);
  useEffect(() => setLabel(m.label), [m.label]);
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const area = calibration ? formatArea(polygonAreaM2(m.points, calibration.pixelsPerMeter)) : '—';
  const perim = calibration ? formatLength(polygonPerimeterMeters(m.points, calibration.pixelsPerMeter)) : '—';

  const commit = () => {
    const v = label.trim();
    if (v && v !== m.label) onRename(m.id, v);
    else setLabel(m.label);
  };

  return (
    <li
      ref={rowRef}
      onClick={() => onSelect(m)}
      className={
        'group cursor-pointer border-b border-slate-700/60 px-2 py-1.5 text-xs transition-colors ' +
        (selected ? 'bg-sky-900/40 ring-1 ring-inset ring-sky-600' : 'hover:bg-slate-700/40')
      }
    >
      <div className="flex items-center gap-1.5">
        <span
          className="h-3 w-3 shrink-0 rounded-sm border border-black/30"
          style={{ backgroundColor: m.color }}
          aria-hidden="true"
        />
        <input
          value={label}
          aria-label="שם המדידה"
          onChange={(e) => setLabel(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onFocus={() => onSelect(m)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            else if (e.key === 'Escape') {
              setLabel(m.label);
              requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
            }
          }}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-slate-100 hover:border-slate-600 focus:border-sky-500 focus:bg-slate-900 focus:outline-none"
        />
        {showPage && <span className="shrink-0 text-[10px] text-slate-500">דף {m.page}</span>}
        <button
          type="button"
          title="מחק מדידה"
          aria-label="מחק מדידה"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(m.id);
          }}
          className="shrink-0 rounded p-0.5 text-slate-500 opacity-60 hover:bg-red-900/50 hover:text-red-300 group-hover:opacity-100"
        >
          <IconTrash size={14} />
        </button>
      </div>
      <div className="mt-0.5 flex gap-3 ps-[1.125rem] font-mono tabular-nums text-slate-400">
        <span title="שטח">
          <span className="font-sans text-slate-500">שטח </span>
          <span className={calibration ? 'text-slate-100' : 'text-amber-400'} dir="ltr">
            {area}
          </span>
        </span>
        <span title="היקף">
          <span className="font-sans text-slate-500">היקף </span>
          <span dir="ltr">{perim}</span>
        </span>
      </div>
    </li>
  );
});

export default function MeasurementsPanel() {
  const numPages = useViewer((s) => s.numPages);
  const currentPage = useViewer((s) => s.currentPage);
  const measurements = useViewer((s) => s.measurements);
  const calibrations = useViewer((s) => s.calibrations);
  const selectedId = useViewer((s) => s.selectedId);
  const select = useViewer((s) => s.select);
  const updateMeasurement = useViewer((s) => s.updateMeasurement);
  const removeMeasurement = useViewer((s) => s.removeMeasurement);

  const [allPages, setAllPages] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const visible = useMemo(
    () =>
      allPages
        ? [...measurements].sort((a, b) => a.page - b.page)
        : measurements.filter((m) => m.page === currentPage),
    [allPages, measurements, currentPage],
  );

  const totals = useMemo(() => {
    let page = 0;
    let doc = 0;
    let uncalibrated = 0;
    for (const m of measurements) {
      const c = calibrations[m.page];
      if (!c) {
        uncalibrated++;
        continue;
      }
      const a = polygonAreaM2(m.points, c.pixelsPerMeter);
      doc += a;
      if (m.page === currentPage) page += a;
    }
    return { page, doc, uncalibrated };
  }, [measurements, calibrations, currentPage]);

  const onSelect = useMemo(
    () => (m: AreaMeasurement) => {
      const s = useViewer.getState();
      if (m.page !== s.currentPage) s.setPage(m.page); // setPage clears selection, so select after
      select(m.id);
    },
    [select],
  );
  const onRename = useMemo(() => (id: string, label: string) => updateMeasurement(id, { label }), [updateMeasurement]);

  if (numPages === 0) return null;

  if (collapsed) {
    return (
      <aside className="flex w-8 shrink-0 flex-col items-center border-s border-slate-700 bg-slate-800 py-2">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="הצג רשימת מדידות"
          className="relative rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-white"
        >
          <IconList />
          {measurements.length > 0 && (
            <span className="absolute -end-1 -top-1 rounded-full bg-sky-600 px-1 text-[9px] leading-4 text-white">
              {measurements.length}
            </span>
          )}
        </button>
      </aside>
    );
  }

  const pageCalibrated = !!calibrations[currentPage];

  return (
    <aside className="flex w-72 shrink-0 flex-col border-s border-slate-700 bg-slate-800/80 text-slate-200">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-slate-700 px-2 text-[11px] text-slate-400">
        <span className="font-semibold text-slate-300">מדידות</span>
        <span>({visible.length})</span>
        <div className="flex-1" />
        <label className="flex cursor-pointer select-none items-center gap-1">
          <input
            type="checkbox"
            checked={allPages}
            onChange={(e) => setAllPages(e.target.checked)}
            className="h-3 w-3 accent-sky-500"
          />
          כל הדפים
        </label>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="הסתר"
          className="rounded p-0.5 text-slate-400 hover:bg-slate-700 hover:text-white"
        >
          <IconList size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="p-4 text-xs leading-relaxed text-slate-400">
            <p className="mb-2 font-semibold text-slate-300">
              {allPages ? 'אין מדידות במסמך' : `אין מדידות בדף ${currentPage}`}
            </p>
            <ol className="list-inside list-decimal space-y-1.5">
              <li className={pageCalibrated ? 'text-emerald-400' : ''}>
                כייל קנה מידה <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">C</kbd> — סמן שתי
                נקודות על מידה ידועה והזן את אורכה במטרים
                {pageCalibrated && ' ✓'}
              </li>
              <li>
                סמן נקודות על החזית <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">A</kbd> — לחיצה
                על כל פינה
              </li>
              <li>
                סגור את הפוליגון — לחיצה על הנקודה הראשונה או <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">Enter</kbd>
              </li>
            </ol>
          </div>
        ) : (
          <ul>
            {visible.map((m) => (
              <Row
                key={m.id}
                m={m}
                calibration={calibrations[m.page]}
                selected={m.id === selectedId}
                showPage={allPages}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={removeMeasurement}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 space-y-0.5 border-t border-slate-700 bg-slate-900/60 px-2 py-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-slate-400">סה״כ בדף {currentPage}</span>
          <span className="font-mono tabular-nums text-slate-100" dir="ltr">
            {pageCalibrated ? formatArea(totals.page) : '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">סה״כ במסמך</span>
          <span className="font-mono font-semibold tabular-nums text-sky-300" dir="ltr">
            {formatArea(totals.doc)}
          </span>
        </div>
        {totals.uncalibrated > 0 && (
          <div className="text-[10px] text-amber-400">
            {totals.uncalibrated} מדידות בדפים לא מכוילים אינן כלולות בסיכום
          </div>
        )}
      </div>
    </aside>
  );
}
