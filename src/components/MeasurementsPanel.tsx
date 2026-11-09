import { startNewCountItem } from './shell/CountFinishButton';
import { scrollWithin } from './ui/scrollWithin';
import { Fragment, memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useViewer } from '../state/store';
import type { AreaMeasurement, Calibration, MeasurementKind } from '../core/types';
import {
  KIND_LABELS,
  assignDeductions,
  categoryKey,
  computeCategorySummaries,
  computeDocumentSummary,
  computeNetAreas,
  computePageSummary,
  formatArea,
  formatItemDims,
  formatLength,
  isMarkupKind,
  itemOf,
  detailsOf,
  itemQuantities,
  kindOf,
  polygonAreaM2,
  polygonPerimeterMeters,
  polylineLengthMeters,
  type CategorySummary,
  type MeasurementSummary,
} from '../core/measurementEngine';
import {
  IconArrow,
  IconCloud,
  IconCount,
  IconDeduct,
  IconDiamond,
  IconDraw,
  IconEllipse,
  IconLine,
  IconLink,
  IconTriangle,
  IconEdit,
  IconHighlight,
  IconLength,
  IconList,
  IconNote,
  IconPolygon,
  IconRect,
  IconText,
  IconTrash,
} from './ui/icons';
import type { MarkupKind } from '../core/types';
import { useMarkup } from '../state/markupStore';
import { MeasurementCategorySelect } from './CategorySelect';

const KIND_BADGE: Record<MeasurementKind, string> = {
  area: 'border-sky-700/70 bg-sky-900/40 text-sky-300',
  deduct: 'border-rose-700/70 bg-rose-900/40 text-rose-300',
  length: 'border-amber-700/70 bg-amber-900/40 text-amber-300',
  count: 'border-violet-700/70 bg-violet-900/40 text-violet-300',
};
const KIND_ICON: Record<MeasurementKind, typeof IconPolygon> = {
  area: IconPolygon,
  deduct: IconDeduct,
  length: IconLength,
  count: IconCount,
};

const negArea = (m2: number) => formatArea(m2 === 0 ? 0 : -m2);

interface RowProps {
  m: AreaMeasurement;
  calibration: Calibration | undefined;
  /** Area rows: net area when the area has deductions. */
  netM2: number | undefined;
  /** Deduct rows: label of the owning area, or null when outside every area. */
  parentLabel: string | null | undefined;
  selected: boolean;
  showPage: boolean;
  onSelect(m: AreaMeasurement): void;
  onRename(id: string, label: string): void;
  onDelete(id: string): void;
}

const Row = memo(function Row({ m, calibration, netM2, parentLabel, selected, showPage, onSelect, onRename, onDelete }: RowProps) {
  const kind = kindOf(m) as MeasurementKind; // takeoff rows only (markup has its own list)
  const KindIcon = KIND_ICON[kind];
  const [label, setLabel] = useState(m.label);
  useEffect(() => setLabel(m.label), [m.label]);
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (selected) scrollWithin(rowRef.current, 'y');
  }, [selected]);

  const ppm = calibration?.pixelsPerMeter;
  const areaM2 = ppm ? polygonAreaM2(m.points, ppm) : null;
  const area = areaM2 === null ? '—' : kind === 'deduct' ? negArea(areaM2) : formatArea(areaM2);
  const perim = ppm ? formatLength(polygonPerimeterMeters(m.points, ppm)) : '—';
  const length = ppm ? formatLength(polylineLengthMeters(m.points, ppm)) : '—';

  const commit = () => {
    const v = label.trim();
    if (v && v !== m.label) onRename(m.id, v);
    else setLabel(m.label);
  };

  return (
    <li
      ref={rowRef}
      onClick={() => onSelect(m)}
      data-testid="measurement-row"
      data-kind={kind}
      className={
        'group cursor-pointer border-b border-slate-700/60 px-2 py-1.5 text-xs transition-colors ' +
        (selected ? 'bg-sky-900/40 ring-1 ring-inset ring-sky-600' : 'hover:bg-slate-700/40')
      }
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`flex h-5 shrink-0 items-center gap-0.5 rounded border px-1 text-[10px] ${KIND_BADGE[kind]}`}
          title={KIND_LABELS[kind]}
        >
          <KindIcon size={12} style={{ color: m.color }} />
          {KIND_LABELS[kind]}
        </span>
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
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 ps-1 font-mono tabular-nums text-slate-400">
        {kind === 'count' ? (
          <>
            <span title="כמות">
              <span className="font-sans text-slate-500">כמות </span>
              <span className="text-slate-100" dir="ltr" data-testid="row-count">
                ×{m.points.length}
              </span>
            </span>
            <ItemDimsButton m={m} />
          </>
        ) : kind === 'length' ? (
          <span title="אורך">
            <span className="font-sans text-slate-500">אורך </span>
            <span className={calibration ? 'text-slate-100' : 'text-amber-400'} dir="ltr" data-testid="row-length">
              {length}
            </span>
          </span>
        ) : (
          <>
            <span title="שטח">
              <span className="font-sans text-slate-500">שטח </span>
              <span
                className={!calibration ? 'text-amber-400' : kind === 'deduct' ? 'text-rose-300' : 'text-slate-100'}
                dir="ltr"
                data-testid="row-area"
              >
                {area}
              </span>
            </span>
            <span title="היקף">
              <span className="font-sans text-slate-500">היקף </span>
              <span dir="ltr">{perim}</span>
            </span>
          </>
        )}
        {(kind === 'area' || kind === 'length') && (
          <button
            type="button"
            data-testid="as-item-toggle"
            aria-pressed={!!m.asItem}
            title={m.asItem ? 'מופיע בטבלת הפריטים — לחץ להוצאה' : 'הוסף לטבלת הפריטים (למשל קיר מסך)'}
            onClick={(e) => {
              e.stopPropagation();
              useViewer.getState().updateMeasurement(m.id, { asItem: m.asItem ? undefined : true });
            }}
            className={
              'rounded border px-1 font-sans text-[10px] ' +
              (m.asItem ? 'border-emerald-700/70 bg-emerald-900/40 text-emerald-200' : 'border-dashed border-slate-600 text-slate-400 hover:text-slate-200')
            }
          >
            {m.asItem ? '✓ פריט' : '+ כפריט'}
          </button>
        )}
        <span className="ms-auto font-sans">
          <MeasurementCategorySelect id={m.id} value={categoryKey(m)} />
        </span>
      </div>
      {kind === 'count' && <ItemDimsEditor m={m} />}
      {kind === 'area' && netM2 !== undefined && (
        <div className="ps-1 font-mono tabular-nums text-slate-400" data-testid="row-net">
          <span className="font-sans text-slate-500">נטו: </span>
          <span className="font-semibold text-emerald-300" dir="ltr">
            {formatArea(netM2)}
          </span>
        </div>
      )}
      {kind === 'deduct' && parentLabel !== undefined && (
        <div className={`ps-1 text-[10px] ${parentLabel ? 'text-slate-500' : 'text-amber-400'}`}>
          {parentLabel ? `מנוכה מ: ${parentLabel}` : 'מחוץ לכל שטח — לא נוכה'}
        </div>
      )}
    </li>
  );
});

interface PanelProps {
  /** When given (drawer mode), the header button hides the drawer instead of collapsing in place. */
  onHide?: () => void;
  /** Extra header buttons (e.g. the drawer's pin toggle). */
  headerActions?: ReactNode;
}

export default function MeasurementsPanel({ onHide, headerActions }: PanelProps = {}) {
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
  const [grouped, setGrouped] = useState(false);
  const categories = useViewer((s) => s.categories);

  const { visible, visibleMarkup } = useMemo(() => {
    const scope = allPages
      ? [...measurements].sort((a, b) => a.page - b.page)
      : measurements.filter((m) => m.page === currentPage);
    return {
      visible: scope.filter((m) => !isMarkupKind(m.kind)),
      visibleMarkup: scope.filter((m) => isMarkupKind(m.kind)),
    };
  }, [allPages, measurements, currentPage]);

  const derived = useMemo(() => {
    const assignment = assignDeductions(measurements);
    const nets = computeNetAreas(measurements, calibrations, assignment);
    const labels = new Map(measurements.map((m) => [m.id, m.label]));
    return {
      assignment,
      nets,
      labels,
      page: computePageSummary(measurements, calibrations, currentPage),
      doc: computeDocumentSummary(measurements, calibrations),
    };
  }, [measurements, calibrations, currentPage]);

  // Group-by-category: visible rows bucketed per category, with subtotals over the same scope.
  const groups = useMemo(() => {
    if (!grouped) return null;
    const scope = allPages ? measurements : measurements.filter((m) => m.page === currentPage);
    return computeCategorySummaries(scope, calibrations, categories).map((g) => ({
      ...g,
      items: visible.filter((m) => categoryKey(m) === g.category),
      color: categories.find((c) => c.id === g.category)?.color,
    }));
  }, [grouped, allPages, measurements, currentPage, calibrations, categories, visible]);

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
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-700 px-2 py-1 text-[11px] text-slate-400">
        <span className="font-semibold text-slate-300">מדידות</span>
        <span>({visible.length})</span>
        <button
          type="button"
          onClick={startNewCountItem}
          data-testid="new-count-item"
          title="סימון פריט חדש בשרטוט (כלי ספירה)"
          className="whitespace-nowrap rounded border border-emerald-700/70 bg-emerald-900/30 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-800/50 hover:text-white"
        >
          + פריט חדש
        </button>
        <div className="flex-1" />
        <label className="flex cursor-pointer select-none items-center gap-1" title="קבץ לפי קטגוריה עם סיכומי ביניים">
          <input
            type="checkbox"
            checked={grouped}
            onChange={(e) => setGrouped(e.target.checked)}
            className="h-3 w-3 accent-sky-500"
            data-testid="group-by-category"
          />
          לפי קטגוריה
        </label>
        <label className="flex cursor-pointer select-none items-center gap-1">
          <input
            type="checkbox"
            checked={allPages}
            onChange={(e) => setAllPages(e.target.checked)}
            className="h-3 w-3 accent-sky-500"
          />
          כל הדפים
        </label>
        {headerActions}
        <button
          type="button"
          onClick={() => (onHide ? onHide() : setCollapsed(true))}
          title={onHide ? 'סגור (M)' : 'הסתר'}
          aria-label="סגור רשימת מדידות"
          className="rounded p-0.5 text-slate-400 hover:bg-slate-700 hover:text-white"
        >
          <IconList size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 && visibleMarkup.length > 0 ? null : visible.length === 0 ? (
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
              <li>
                פתחים לניכוי (חלונות/דלתות) <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">D</kbd> —
                סמן בתוך החזית; השטח ינוכה ממנה
              </li>
              <li>
                ספירת פריטים <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">N</kbd> — לחיצה על כל
                פריט; <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">Enter</kbd> לסיום הקבוצה,
                קליק ימני / Alt+קליק מסיר סימון
              </li>
              <li>
                מדידת אורך <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">L</kbd> — לחיצה כפולה או{' '}
                <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">Enter</kbd> לסיום
              </li>
              <li>
                הערות וסימונים — הערה <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">K</kbd>, טקסט{' '}
                <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">X</kbd>, ענן תיקון{' '}
                <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">U</kbd>, חץ{' '}
                <kbd className="rounded bg-slate-700 px-1 font-mono text-[10px]">W</kbd> ועוד (אינם נכללים בכמויות)
              </li>
            </ol>
          </div>
        ) : (
          <ul>
            {(groups ?? [{ category: '', name: '', summary: null, items: visible, color: undefined }]).map((g) => (
              <Fragment key={g.category || '_'}>
                {groups && <CategoryHeader g={g as CategorySummary} color={g.color} count={g.items.length} />}
                {g.items.map((m) => {
                  const net = derived.nets.get(m.id);
                  const parent = derived.assignment.get(m.id);
                  return (
                    <Row
                      key={m.id}
                      m={m}
                      calibration={calibrations[m.page]}
                      netM2={net && net.deductIds.length ? net.netM2 : undefined}
                      parentLabel={
                        parent === undefined ? undefined : parent === null ? null : (derived.labels.get(parent) ?? null)
                      }
                      selected={m.id === selectedId}
                      showPage={allPages}
                      onSelect={onSelect}
                      onRename={onRename}
                      onDelete={removeMeasurement}
                    />
                  );
                })}
              </Fragment>
            ))}
          </ul>
        )}
        {visibleMarkup.length > 0 && (
          <MarkupList items={visibleMarkup} selectedId={selectedId} showPage={allPages} onSelect={onSelect} onDelete={removeMeasurement} />
        )}
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-slate-700 bg-slate-900/60 px-2 py-1.5 text-xs">
        <SummaryBlock
          title={`דף ${currentPage}`}
          s={derived.page}
          calibrated={pageCalibrated}
          testId="summary-page"
        />
        <SummaryBlock title="מסמך" s={derived.doc} calibrated testId="summary-doc" strong />
        {derived.doc.uncalibrated > 0 && (
          <div className="text-[10px] text-amber-400">
            {derived.doc.uncalibrated} מדידות בדפים לא מכוילים אינן כלולות בסיכום
          </div>
        )}
        {derived.doc.orphanDeducts > 0 && (
          <div className="text-[10px] text-amber-400">
            {derived.doc.orphanDeducts} פתחים מחוץ לשטחי חזית אינם מנוכים
          </div>
        )}
      </div>
    </aside>
  );
}

function SummaryBlock({
  title,
  s,
  calibrated,
  testId,
  strong,
}: {
  title: string;
  s: MeasurementSummary;
  calibrated: boolean;
  testId: string;
  strong?: boolean;
}) {
  const v = (text: string) => (calibrated ? text : '—');
  const row = (label: string, value: string, key: string, cls = 'text-slate-100') => (
    <div className="flex justify-between">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono tabular-nums ${cls}`} dir="ltr" data-testid={`${testId}-${key}`}>
        {value}
      </span>
    </div>
  );
  return (
    <div data-testid={testId}>
      <div className={`mb-0.5 text-[10px] font-semibold uppercase ${strong ? 'text-sky-300' : 'text-slate-400'}`}>
        סה״כ {title}
      </div>
      {row('ברוטו', v(formatArea(s.grossM2)), 'gross')}
      {row('ניכויים', v(negArea(s.deductM2)), 'deduct', 'text-rose-300')}
      {row('נטו', v(formatArea(s.netM2)), 'net', strong ? 'font-semibold text-sky-300' : 'font-semibold text-emerald-300')}
      {row('סה״כ אורך', v(formatLength(s.lengthM)), 'length', 'text-amber-300')}
      {s.count > 0 && row('סה״כ כמות', `×${s.count}`, 'count', 'text-violet-300')}
      {s.itemAreaM2 > 0 && row('שטח פריטים', formatArea(s.itemAreaM2), 'item-area', 'text-violet-300')}
      {s.itemPerimeterM > 0 && row('היקף פרופיל', formatLength(s.itemPerimeterM), 'item-perim', 'text-violet-300')}
    </div>
  );
}

/** Sticky group header with the category's subtotals (net area / length / count). */
function CategoryHeader({ g, color, count }: { g: CategorySummary; color: string | undefined; count: number }) {
  const t = g.summary;
  const parts: string[] = [];
  if (t.grossM2 > 0 || t.deductM2 > 0) parts.push(`נטו ${formatArea(t.netM2)}`);
  if (t.openingsM2 > 0) parts.push(`פתחים ${formatArea(t.openingsM2)}`);
  if (t.lengthM > 0) parts.push(formatLength(t.lengthM));
  if (t.count > 0) parts.push(`\u2066×${t.count}\u2069`);
  if (t.itemAreaM2 > 0) parts.push(`פריטים ${formatArea(t.itemAreaM2)}`);
  return (
    <li
      className="sticky top-0 z-10 border-b border-slate-700 bg-slate-900/95 px-2 py-1 text-[11px]"
      data-testid="category-group"
      data-category={g.category}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full border border-slate-500"
          style={{ background: color ?? 'transparent' }}
        />
        <span className="font-semibold text-slate-200">{g.name}</span>
        <span className="text-slate-500">({count})</span>
      </div>
      <div className="ps-4 font-mono tabular-nums text-sky-300" data-testid="category-subtotal">
        {parts.length ? parts.join(' · ') : '—'}
      </div>
    </li>
  );
}

const MARKUP_ICON: Record<MarkupKind, typeof IconPolygon> = {
  note: IconNote,
  text: IconText,
  rect: IconRect,
  ellipse: IconEllipse,
  triangle: IconTriangle,
  diamond: IconDiamond,
  line: IconLine,
  cloud: IconCloud,
  arrow: IconArrow,
  pen: IconDraw,
  highlight: IconHighlight,
  link: IconLink,
};

/** "הערות וסימונים": annotations (not quantities) with jump-to, edit and delete. */
function MarkupList({
  items,
  selectedId,
  showPage,
  onSelect,
  onDelete,
}: {
  items: AreaMeasurement[];
  selectedId: string | null;
  showPage: boolean;
  onSelect(m: AreaMeasurement): void;
  onDelete(id: string): void;
}) {
  const edit = (m: AreaMeasurement) => {
    onSelect(m);
    useMarkup.getState().startEditing(m.id);
  };
  return (
    <section data-testid="markup-list" className="border-t border-slate-700">
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-slate-700 bg-slate-900/95 px-2 py-1 text-[11px]">
        <IconNote size={12} className="text-amber-300" />
        <span className="font-semibold text-slate-200">הערות וסימונים</span>
        <span className="text-slate-500">({items.length})</span>
        <span className="ms-auto text-[10px] text-slate-500">לא נכללים בכמויות</span>
      </div>
      <ul>
        {items.map((m) => {
          const kind = kindOf(m) as MarkupKind;
          const Icon = MARKUP_ICON[kind] ?? IconNote;
          const editable = kind === 'note' || kind === 'text';
          const text = (m.text ?? '').trim();
          const selected = m.id === selectedId;
          return (
            <li
              key={m.id}
              data-testid="markup-row"
              data-kind={kind}
              onClick={() => onSelect(m)}
              onDoubleClick={() => editable && edit(m)}
              className={
                'group flex cursor-pointer items-start gap-1.5 border-b border-slate-700/60 px-2 py-1.5 text-xs ' +
                (selected ? 'bg-sky-900/40 ring-1 ring-inset ring-sky-600' : 'hover:bg-slate-700/40')
              }
            >
              <Icon size={14} className="mt-0.5 shrink-0" style={{ color: m.color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-slate-200">{m.label}</span>
                  <span className="text-[10px] text-slate-500">{KIND_LABELS[kind]}</span>
                  {showPage && <span className="ms-auto shrink-0 text-[10px] text-slate-500">דף {m.page}</span>}
                </div>
                {editable && (
                  <div
                    className={`mt-0.5 line-clamp-3 whitespace-pre-wrap break-words ${text ? 'text-slate-300' : 'italic text-slate-500'}`}
                    data-testid="markup-row-text"
                  >
                    {text || 'ללא טקסט'}
                  </div>
                )}
              </div>
              {editable && (
                <button
                  type="button"
                  title="ערוך טקסט"
                  aria-label="ערוך טקסט"
                  onClick={(e) => {
                    e.stopPropagation();
                    edit(m);
                  }}
                  className="shrink-0 rounded p-0.5 text-slate-500 opacity-60 hover:bg-slate-700 hover:text-slate-200 group-hover:opacity-100"
                >
                  <IconEdit size={14} />
                </button>
              )}
              <button
                type="button"
                title="מחק"
                aria-label="מחק סימון"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(m.id);
                }}
                className="shrink-0 rounded p-0.5 text-slate-500 opacity-60 hover:bg-red-900/50 hover:text-red-300 group-hover:opacity-100"
              >
                <IconTrash size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---- item dimensions (count groups) -----------------------------------------

/** Which count row has its "מידות פריט" editor open (one at a time). */
let openItemEditor: string | null = null;
const itemEditorListeners = new Set<() => void>();
function setOpenItemEditor(id: string | null) {
  openItemEditor = id;
  itemEditorListeners.forEach((l) => l());
}
function useItemEditorOpen(id: string): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    itemEditorListeners.add(l);
    return () => void itemEditorListeners.delete(l);
  }, []);
  return openItemEditor === id;
}

/** Compact chip on a count row: "W1 150×140" or "+ מידות פריט". */
function ItemDimsButton({ m }: { m: AreaMeasurement }) {
  const it = itemOf(m);
  const open = useItemEditorOpen(m.id);
  return (
    <button
      type="button"
      data-testid="item-dims-toggle"
      aria-expanded={open}
      title="מידות ופרטי הפריט — רוחב × גובה, קוד ופרטים חופשיים (זכוכית, צבע, פרופיל…)"
      onClick={(e) => {
        e.stopPropagation();
        setOpenItemEditor(open ? null : m.id);
      }}
      className={
        'rounded border px-1 font-sans text-[10px] ' +
        (it ? 'border-violet-700/70 bg-violet-900/30 text-violet-200' : 'border-dashed border-slate-600 text-slate-400 hover:text-slate-200')
      }
    >
      {it ? <span dir="ltr">{formatItemDims(it)}</span> : detailsOf(m).length ? 'פרטים' : '+ מידות ופרטים'}
    </button>
  );
}

/** cm input (plain number = centimetres; "1.5 מ" / "1500 mm" also accepted) → meters. */
function parseCm(t: string): number | undefined {
  const s = t.trim().replace(',', '.');
  if (!s) return undefined;
  const m = /^([0-9]*\.?[0-9]+)\s*(.*)$/.exec(s);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (!(v > 0)) return undefined;
  const u = m[2].trim().toLowerCase();
  if (!u || /^(cm|ס["״]?מ)$/.test(u)) return v / 100;
  if (/^(mm|מ["״]?מ)$/.test(u)) return v / 1000;
  if (/^(m|מ|מ['׳]|מטר)$/.test(u)) return v;
  return undefined;
}

const cmText = (meters: number | undefined) => (meters ? String(Math.round(meters * 1000) / 10) : '');

function ItemDimsEditor({ m }: { m: AreaMeasurement }) {
  const open = useItemEditorOpen(m.id);
  const it = itemOf(m);
  const [w, setW] = useState(cmText(it?.width));
  const [h, setH] = useState(cmText(it?.height));
  const [code, setCode] = useState(it?.code ?? '');
  const [rows, setRows] = useState<{ k: string; v: string }[]>(detailsOf(m));
  useEffect(() => {
    if (!open) return;
    setW(cmText(it?.width));
    setH(cmText(it?.height));
    setCode(it?.code ?? '');
    setRows(detailsOf(m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) {
    const q = itemQuantities(m);
    const det = detailsOf(m);
    return q || det.length ? (
      <>
        {q && (
          <div className="ps-1 font-mono tabular-nums text-[10px] text-violet-300" data-testid="row-item-qty">
            <span className="font-sans text-slate-500">זיגוג </span>
            <span dir="ltr">{formatArea(q.areaM2)}</span>
            <span className="font-sans text-slate-500"> · פרופיל </span>
            <span dir="ltr">{formatLength(q.perimeterM)}</span>
          </div>
        )}
        {det.length > 0 && (
          <div className="flex flex-wrap gap-1 ps-1 pt-0.5" data-testid="row-item-details">
            {det.map((d, i) => (
              <span key={i} className="rounded bg-slate-700/70 px-1 text-[10px] text-slate-200">
                {d.k && <span className="text-slate-400">{d.k}: </span>}
                {d.v}
              </span>
            ))}
          </div>
        )}
      </>
    ) : null;
  }
  const pw = parseCm(w);
  const ph = parseCm(h);
  const bad = (w.trim() !== '' && pw === undefined) || (h.trim() !== '' && ph === undefined);
  const save = () => {
    let item: AreaMeasurement['item'];
    if (pw && ph) item = { width: pw, height: ph, ...(code.trim() ? { code: code.trim() } : {}) };
    else if (!w.trim() && !h.trim()) item = undefined;
    else return;
    const details = rows.map((d) => ({ k: d.k.trim(), v: d.v.trim() })).filter((d) => d.k || d.v);
    useViewer.getState().updateMeasurement(m.id, { item, details: details.length ? details : undefined });
    setOpenItemEditor(null);
  };
  const setRow = (i: number, patch: Partial<{ k: string; v: string }>) => setRows((r) => r.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const detailInput = (value: string, onChange: (v: string) => void, placeholder: string, cls: string, testId: string) => (
    <input
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      data-testid={testId}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') save();
        else if (e.key === 'Escape') setOpenItemEditor(null);
      }}
      className={'h-6 min-w-0 rounded border border-slate-600 bg-slate-900 px-1 text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none ' + cls}
    />
  );
  const input = (value: string, set: (v: string) => void, label: string, testId: string, cls = 'w-14') => (
    <label className="flex flex-col gap-0.5 text-[10px] text-slate-400">
      {label}
      <input
        value={value}
        dir="ltr"
        inputMode={testId === 'item-code' ? 'text' : 'decimal'}
        aria-label={label}
        data-testid={testId}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') save();
          else if (e.key === 'Escape') setOpenItemEditor(null);
        }}
        className={'h-6 rounded border border-slate-600 bg-slate-900 px-1 text-center font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none ' + cls}
      />
    </label>
  );
  const preview = pw && ph ? itemQuantities({ ...m, item: { width: pw, height: ph } }) : null;
  return (
    <div
      className="mt-1 rounded border border-violet-800/60 bg-slate-900/70 p-1.5"
      data-testid="item-dims-editor"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-end gap-1.5">
        {input(w, setW, 'רוחב (ס״מ)', 'item-width')}
        <span className="pb-1 text-slate-500">×</span>
        {input(h, setH, 'גובה (ס״מ)', 'item-height')}
        {input(code, setCode, 'קוד', 'item-code', 'w-14')}
        <button
          type="button"
          onClick={save}
          disabled={bad}
          data-testid="item-dims-save"
          className="h-6 rounded bg-violet-700 px-2 text-[11px] text-white hover:bg-violet-600 disabled:opacity-40"
        >
          שמור
        </button>
        {it && (
          <button
            type="button"
            onClick={() => {
              useViewer.getState().updateMeasurement(m.id, { item: undefined });
              setOpenItemEditor(null);
            }}
            className="h-6 rounded px-1.5 text-[11px] text-slate-400 hover:bg-slate-700 hover:text-white"
          >
            הסר
          </button>
        )}
      </div>
      <div className="mt-1.5 space-y-1" data-testid="item-details">
        {rows.map((d, i) => (
          <div key={i} className="flex items-center gap-1">
            {detailInput(d.k, (v) => setRow(i, { k: v }), 'שדה (זכוכית, צבע…)', 'w-24', `detail-key-${i}`)}
            {detailInput(d.v, (v) => setRow(i, { v }), 'ערך', 'flex-1', `detail-value-${i}`)}
            <button
              type="button"
              aria-label="הסר פרט"
              onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
              className="h-6 shrink-0 rounded px-1 text-slate-500 hover:bg-slate-700 hover:text-red-300"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          data-testid="detail-add"
          onClick={() => setRows((r) => [...r, { k: '', v: '' }])}
          className="rounded border border-dashed border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-violet-500 hover:text-white"
        >
          + הוסף פרט
        </button>
      </div>
      <div className="mt-1 text-[10px] text-slate-500">
        {bad
          ? 'מידה לא תקינה — מספר בס״מ (או עם יחידה: 1.5 מ, 1500 מ״מ)'
          : preview
            ? `×${m.points.length}: זיגוג ${formatArea(preview.areaM2)} · פרופיל ${formatLength(preview.perimeterM)}`
            : 'מידות פריט אחד; השטח וההיקף מוכפלים בכמות'}
      </div>
    </div>
  );
}
