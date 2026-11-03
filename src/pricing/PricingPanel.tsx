/**
 * "תמחור" — live bill of quantities (כתב כמויות) with inline-editable price
 * book. Lives as a tab of the left drawer, next to the measurements list.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useViewer } from '../state/store';
import { openExportDialog } from '../export/exportUi';
import { IconDownload, IconX } from '../components/ui/icons';
import {
  PRICE_UNITS,
  UNIT_LABELS,
  buildBoq,
  describeQuantity,
  formatMoneyNumber,
  resolvePricing,
  type BoqLine,
  type PriceUnit,
} from './boq';
import { usePricing } from './store';

const parseNum = (t: string): number | undefined => {
  const v = Number(t.replace(/[,\s₪%]/g, '').replace(/^\./, '0.'));
  return t.trim() === '' || !Number.isFinite(v) || v < 0 ? undefined : v;
};

/** Number input that commits on blur / Enter (Esc reverts); empty = unset. */
function NumField({
  value,
  onCommit,
  label,
  suffix,
  placeholder,
  testId,
  className = 'w-20',
  max,
}: {
  value: number | undefined;
  onCommit(v: number | undefined): void;
  label: string;
  suffix?: string;
  placeholder?: string;
  testId?: string;
  className?: string;
  max?: number;
}) {
  const shown = value === undefined ? '' : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    let v = parseNum(text);
    if (v !== undefined && max !== undefined) v = Math.min(v, max);
    if (v !== value) onCommit(v);
    else setText(shown);
  };
  return (
    <label className="flex items-center gap-1 text-[11px] text-slate-400">
      <span className="whitespace-nowrap">{label}</span>
      <span className="relative flex items-center">
        <input
          type="text"
          inputMode="decimal"
          dir="ltr"
          value={text}
          placeholder={placeholder}
          aria-label={label}
          data-testid={testId}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            else if (e.key === 'Escape') {
              setText(shown);
              requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
            }
          }}
          className={
            'h-7 rounded border border-slate-600 bg-slate-900 px-1.5 text-end font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none ' +
            className
          }
        />
        {suffix && <span className="ms-1 text-slate-500">{suffix}</span>}
      </span>
    </label>
  );
}

function TextField({ value, onCommit, label, testId }: { value: string; onCommit(v: string): void; label: string; testId?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-slate-400">
      {label}
      <input
        type="text"
        dir="auto"
        value={text}
        data-testid={testId}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onCommit(text.trim())}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className="h-7 min-w-0 rounded border border-slate-600 bg-slate-900 px-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
      />
    </label>
  );
}

const money = (v: number) => formatMoneyNumber(v);

function LineCard({ l, currency }: { l: BoqLine; currency: string }) {
  const setCategory = usePricing((s) => s.setCategory);
  const globalEntry = usePricing((s) => s.global.categories[l.category]);
  const unitLabel = UNIT_LABELS[l.unit];
  const detail = describeQuantity(l.unit, l.breakdown);
  return (
    <li className="border-b border-slate-700/60 px-2 py-2 text-xs" data-testid="boq-line" data-category={l.category}>
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-slate-500" style={{ background: l.color ?? 'transparent' }} />
        <span className="min-w-0 flex-1 truncate font-semibold text-slate-100" title={l.name}>
          {l.name}
        </span>
        <select
          value={l.unitIsAuto ? '' : l.unit}
          aria-label={`יחידת תמחור — ${l.name}`}
          data-testid="boq-unit"
          onChange={(e) => setCategory(l.category, { unit: (e.target.value || undefined) as PriceUnit | undefined })}
          onKeyDown={(e) => e.stopPropagation()}
          className="h-6 rounded border border-slate-600 bg-slate-900 px-1 text-[11px] text-slate-200 focus:border-sky-500 focus:outline-none"
        >
          <option value="">אוטו׳ ({l.unitIsAuto ? unitLabel : '—'})</option>
          {PRICE_UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABELS[u]}
            </option>
          ))}
        </select>
        <span className="min-w-[5.5rem] text-end font-mono font-semibold tabular-nums text-emerald-300" dir="ltr" data-testid="boq-line-total">
          {currency} {money(l.total)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 ps-4 font-mono tabular-nums text-slate-400">
        <span>
          <span className="font-sans text-slate-500">כמות </span>
          <span className="text-slate-100" dir="ltr" data-testid="boq-qty">
            {money(l.quantity)}
          </span>{' '}
          <span className="font-sans">{unitLabel}</span>
        </span>
        {l.wastePct > 0 && (
          <span>
            <span className="font-sans text-slate-500">כולל פחת </span>
            <span className="text-slate-200" dir="ltr">
              {money(l.quantityWithWaste)}
            </span>
          </span>
        )}
        {detail && <span className="font-sans text-[10px] text-slate-500">({detail})</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 ps-4">
        <NumField
          label={`מחיר/${unitLabel}`}
          suffix={currency}
          value={l.unitPrice || undefined}
          placeholder={globalEntry?.price !== undefined ? String(globalEntry.price) : '0'}
          onCommit={(v) => setCategory(l.category, { price: v })}
          testId="boq-price"
        />
        <NumField
          label="פחת"
          suffix="%"
          className="w-12"
          max={500}
          value={l.wastePct || undefined}
          placeholder="0"
          onCommit={(v) => setCategory(l.category, { wastePct: v })}
          testId="boq-waste"
        />
        <NumField
          label="עבודה"
          suffix={currency}
          className="w-16"
          value={l.labourPrice || undefined}
          placeholder="0"
          onCommit={(v) => setCategory(l.category, { labour: v })}
          testId="boq-labour"
        />
      </div>
      {l.uncalibrated > 0 && (
        <div className="mt-1 ps-4 text-[10px] text-amber-400">{l.uncalibrated} מדידות בדפים לא מכוילים — לא נכללו</div>
      )}
    </li>
  );
}

function TotalRow({ label, value, strong, children, testId }: { label: string; value: string; strong?: boolean; children?: ReactNode; testId?: string }) {
  return (
    <div className={'flex items-center gap-2 ' + (strong ? 'border-t border-slate-600 pt-1.5 text-sm' : '')}>
      <span className={strong ? 'font-semibold text-sky-200' : 'text-slate-400'}>{label}</span>
      {children}
      <span className="flex-1" />
      <span className={'font-mono tabular-nums ' + (strong ? 'font-bold text-sky-300' : 'text-slate-100')} dir="ltr" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

export default function PricingPanel({ onHide, headerActions }: { onHide?: () => void; headerActions?: ReactNode } = {}) {
  const measurements = useViewer((s) => s.measurements);
  const calibrations = useViewer((s) => s.calibrations);
  const categories = useViewer((s) => s.categories);
  const fileName = useViewer((s) => s.fileName);
  const global = usePricing((s) => s.global);
  const doc = usePricing((s) => s.doc);
  const setSettings = usePricing((s) => s.setSettings);
  const [savedNote, setSavedNote] = useState(false);

  const pricing = useMemo(() => resolvePricing(global, doc), [global, doc]);
  const boq = useMemo(
    () => buildBoq({ measurements, calibrations, categories, pricing }),
    [measurements, calibrations, categories, pricing],
  );
  const cur = boq.currency;
  const hasOverrides = Object.keys(doc.categories).length > 0 || ['vatPct', 'discountPct', 'currency'].some((k) => k in doc.settings);

  useEffect(() => {
    if (!savedNote) return;
    const t = setTimeout(() => setSavedNote(false), 2500);
    return () => clearTimeout(t);
  }, [savedNote]);

  return (
    <aside className="flex w-[24rem] max-w-full shrink-0 flex-col border-s border-slate-700 bg-slate-800/80 text-slate-200" data-testid="pricing-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-slate-700 px-2 text-[11px] text-slate-400">
        <span className="font-semibold text-slate-300">תמחור · כתב כמויות</span>
        <span>({boq.lines.length})</span>
        <div className="flex-1" />
        {headerActions}
        {onHide && (
          <button
            type="button"
            onClick={onHide}
            title="סגור (Q)"
            aria-label="סגור תמחור"
            className="rounded p-0.5 text-slate-400 hover:bg-slate-700 hover:text-white"
          >
            <IconX size={14} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex gap-2 border-b border-slate-700 px-2 py-2">
          <TextField
            label="פרויקט"
            value={pricing.settings.projectName || ''}
            onCommit={(v) => setSettings({ projectName: v })}
            testId="boq-project"
          />
          <TextField label="לקוח" value={pricing.settings.client || ''} onCommit={(v) => setSettings({ client: v })} testId="boq-client" />
        </div>
        {!pricing.settings.projectName && fileName && (
          <p className="px-2 pt-1 text-[10px] text-slate-500">ללא שם פרויקט — ייעשה שימוש בשם הקובץ בייצוא</p>
        )}

        {boq.lines.length === 0 ? (
          <div className="p-4 text-xs leading-relaxed text-slate-400">
            <p className="mb-2 font-semibold text-slate-300">אין עדיין כמויות לתמחור</p>
            <p>
              מדוד שטחים, אורכים או ספירות ושייך אותם לקטגוריות (חלונות, חיפוי…). כל קטגוריה תופיע כאן כשורה בכתב הכמויות,
              עם מחיר ליחידה, פחת ועבודה.
            </p>
          </div>
        ) : (
          <ul>
            {boq.lines.map((l) => (
              <LineCard key={l.category || '_'} l={l} currency={cur} />
            ))}
          </ul>
        )}
        {boq.warnings.length > 0 && (
          <div className="space-y-1 px-2 py-2 text-[11px] text-amber-400" data-testid="boq-warnings">
            {boq.warnings.map((w) => (
              <p key={w}>⚠ {w}</p>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-1 border-t border-slate-700 bg-slate-900/60 px-2 py-2 text-xs" data-testid="boq-totals">
        <TotalRow label="סה״כ לפני הנחה" value={`${cur} ${money(boq.subtotal)}`} testId="boq-subtotal" />
        <TotalRow label="הנחה" value={boq.discount ? `-${cur} ${money(boq.discount)}` : `${cur} 0.00`} testId="boq-discount">
          <NumField
            label=""
            suffix="%"
            className="w-12"
            max={100}
            value={pricing.settings.discountPct || undefined}
            placeholder="0"
            onCommit={(v) => setSettings({ discountPct: v ?? 0 })}
            testId="boq-discount-pct"
          />
        </TotalRow>
        <TotalRow label="מע״מ" value={`${cur} ${money(boq.vat)}`} testId="boq-vat">
          <NumField
            label=""
            suffix="%"
            className="w-12"
            max={100}
            value={pricing.settings.vatPct}
            onCommit={(v) => setSettings({ vatPct: v ?? 0 })}
            testId="boq-vat-pct"
          />
        </TotalRow>
        <TotalRow label="סה״כ לתשלום" value={`${cur} ${money(boq.total)}`} strong testId="boq-total" />
        <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
          <button
            type="button"
            data-testid="boq-export-xlsx"
            onClick={() => openExportDialog('xlsx')}
            className="flex h-7 items-center gap-1 rounded bg-emerald-700 px-2.5 text-xs font-semibold text-white hover:bg-emerald-600"
          >
            <IconDownload size={14} />
            ייצוא ל־Excel
          </button>
          <button
            type="button"
            data-testid="boq-save-global"
            title="המחירים, הפחת, המע״מ וההנחה יוצעו כברירת מחדל בכל פרויקט חדש"
            onClick={() => {
              usePricing.getState().saveAsGlobal();
              setSavedNote(true);
            }}
            className="h-7 rounded border border-slate-600 px-2 text-xs text-slate-200 hover:bg-slate-700"
          >
            שמור כמחירון כללי
          </button>
          {hasOverrides && (
            <button
              type="button"
              data-testid="boq-reset"
              title="מחק את המחירים של המסמך הזה וחזור למחירון הכללי"
              onClick={() => usePricing.getState().resetToGlobal()}
              className="h-7 rounded px-2 text-xs text-slate-400 hover:bg-slate-700 hover:text-white"
            >
              אפס למחירון
            </button>
          )}
        </div>
        {savedNote && (
          <p role="status" className="text-[11px] text-emerald-300">
            נשמר כמחירון כללי — יוצע בפרויקטים הבאים
          </p>
        )}
      </div>
    </aside>
  );
}
