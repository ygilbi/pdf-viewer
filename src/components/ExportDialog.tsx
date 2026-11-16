import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useViewer } from '../state/store';
import { categoryKey, categoryName, isMarkupKind, kindOf } from '../core/measurementEngine';
import { isItem } from '../core/itemTable';
import { useExportUi } from '../export/exportUi';
import { formatPageRanges, parsePageRanges } from '../export/pageSelection';
import { savePickerSupported, startExport, type ExportHandle } from '../export/runExport';
import { DEFAULT_CSV_OPTIONS, DEFAULT_PDF_OPTIONS, type CsvOptions, type ExportFormat, type PdfContentOptions } from '../export/types';
import { baseName } from './ui/util';
import { IconX } from './ui/icons';
import { persistentMeasurements } from '../core/tempMeasurements';
import { buildGilboaPayload, type GilboaPayload } from '../core/gilboaExport';
import { ALOO_KIND_LABEL, buildAlooTsv, copyText } from '../core/alooClipboard';
import { sendToAloo } from './SendToGilboaButton';

const KIND_OPTIONS: { id: CsvOptions['kinds'][number]; label: string }[] = [
  { id: 'area', label: 'שטחים' },
  { id: 'deduct', label: 'ניכויים' },
  { id: 'length', label: 'אורכים' },
  { id: 'count', label: 'ספירות' },
];

const PDF_CONTENT: { id: keyof PdfContentOptions; label: string; hint?: string }[] = [
  { id: 'drawings', label: 'דפי השרטוט', hint: 'התוכן המקורי (וקטורי, ללא המרה לתמונה)' },
  { id: 'measurements', label: 'מדידות על הדף', hint: 'שטחים, ניכויים, אורכים, ספירות ותוויות' },
  { id: 'markup', label: 'סימונים והערות', hint: 'מלבן, ענן, חץ, עט, מרקר, טקסט, נעצי הערה' },
  { id: 'items', label: 'טבלת פריטים', hint: 'שם פריט · קטגוריה · מערכת · גודל · כמות · מידע נוסף, עם סה״כ לכל קטגוריה' },
  { id: 'summary', label: 'טבלאות סיכום כמויות', hint: 'לפי עמוד ולפי קטגוריה, סה״כ, רשימת הערות' },
  { id: 'calibration', label: 'קו כיול' },
  { id: 'legend', label: 'מקרא קטגוריות' },
];

type Dest = ExportFormat | 'aloo';

const DESTS: { id: Dest; label: string; hint: string; icon: ReactNode }[] = [
  { id: 'pdf', label: 'PDF', hint: 'שרטוט עם המדידות וטבלת פריטים', icon: <DestIcon kind="pdf" /> },
  { id: 'xlsx', label: 'Excel', hint: 'טבלת פריטים לעריכה', icon: <DestIcon kind="xlsx" /> },
  { id: 'csv', label: 'CSV', hint: 'טבלה פשוטה לכל תוכנה', icon: <DestIcon kind="csv" /> },
  { id: 'aloo', label: 'ALOO', hint: 'העתקת פריטים להדבקה ב-ALOO', icon: <DestIcon kind="aloo" /> },
];

const DEST_ACCENT: Record<Dest, string> = { pdf: '#ef4444', xlsx: '#10b981', csv: '#38bdf8', aloo: '#a78bfa' };

function DestIcon({ kind }: { kind: Dest }) {
  if (kind === 'aloo')
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        <path d="M11.5 14h5M14 11.5v5" />
      </svg>
    );
  const label = kind === 'xlsx' ? 'XLS' : kind.toUpperCase();
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
      <path d="M14 2v5h5" />
      <text x="12" y="17.5" textAnchor="middle" fontSize="6.2" fontWeight="700" fill="currentColor" stroke="none" fontFamily="system-ui, sans-serif">
        {label}
      </text>
    </svg>
  );
}

const CSV_SECTIONS: { id: 'items' | 'rows' | 'categoryTotals' | 'totals' | 'notes'; label: string }[] = [
  { id: 'items', label: 'טבלת פריטים (בראש הקובץ)' },
  { id: 'rows', label: 'שורת מדידה לכל פריט' },
  { id: 'categoryTotals', label: 'סיכומי ביניים לפי קטגוריה' },
  { id: 'totals', label: 'סה״כ (ברוטו / ניכויים / נטו / אורך / כמות)' },
  { id: 'notes', label: 'הערות וטקסטים' },
];

function Check({
  checked,
  onChange,
  children,
  indeterminate,
  testId,
  disabled,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  children: ReactNode;
  indeterminate?: boolean;
  testId?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <label className={'flex cursor-pointer items-start gap-2 text-sm ' + (disabled ? 'opacity-40' : '')}>
      <input
        ref={ref}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-sky-500"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

function Section({ title, children, aside, step }: { title: string; children: ReactNode; aside?: ReactNode; step?: number }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-slate-700/80 bg-slate-900/40 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold text-slate-100">
          {step != null && (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-[11px] font-bold text-slate-200">{step}</span>
          )}
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const linkBtn = 'rounded px-1.5 py-0.5 text-xs text-sky-300 hover:bg-slate-700 hover:text-white disabled:opacity-40';
const chipBtn =
  'rounded-full border border-slate-600 px-2.5 py-1 text-xs text-slate-200 hover:border-sky-500 hover:bg-slate-700 disabled:opacity-40';

/** Export dialog (PDF / CSV): which pages / files, which content, one output file. */
/**
 * "פתח" after an export: a PDF opens in a new tab (the browser's / desktop app's PDF viewer); Excel / CSV
 * can't be shown in a browser, so they are handed to the system again (download → opens in Excel; on
 * iPhone the system preview).
 */
function openExportedFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const isPdf = blob.type === 'application/pdf' || /\.pdf$/i.test(name);
  let opened: Window | null = null;
  if (isPdf) opened = window.open(url, '_blank');
  if (!opened) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

export function ExportDialog() {
  const open = useExportUi((s) => s.open);
  if (!open) return null;
  return createPortal(<ExportDialogBody />, document.body);
}

function ExportDialogBody() {
  const setOpen = useExportUi((s) => s.setOpen);
  const docs = useViewer((s) => s.docs);
  const numPages = useViewer((s) => s.numPages);
  const currentPage = useViewer((s) => s.currentPage);
  const measurements = useViewer((s) => persistentMeasurements(s.measurements));
  const categories = useViewer((s) => s.categories);

  const perPage = useMemo(() => {
    const m = new Map<number, number>();
    for (const x of measurements) m.set(x.page, (m.get(x.page) ?? 0) + 1);
    return m;
  }, [measurements]);
  const pagesWithData = useMemo(() => [...perPage.keys()].sort((a, b) => a - b), [perPage]);

  const [dest, setDest] = useState<Dest>(() => useExportUi.getState().format ?? 'pdf');
  const format: ExportFormat = dest === 'aloo' ? 'pdf' : dest;
  const [alooState, setAlooState] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(pagesWithData.length ? pagesWithData : [currentPage]),
  );
  const [rangeText, setRangeText] = useState<string | null>(null);
  const [pdfOpts, setPdfOpts] = useState<PdfContentOptions>(DEFAULT_PDF_OPTIONS);
  const [csvOpts, setCsvOpts] = useState<CsvOptions>(DEFAULT_CSV_OPTIONS);
  const [fileName, setFileName] = useState(() =>
    docs.length > 1 ? 'ייצוא-כמויות' : `${baseName(docs[0]?.name ?? null)}-ייצוא`,
  );
  const pickerOk = savePickerSupported();
  const [usePicker, setUsePicker] = useState(pickerOk);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(docs.length <= 3 ? docs.map((d) => d.id) : []));
  const [progress, setProgress] = useState<{ frac: number; text: string } | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; file?: { blob: Blob; name: string } } | null>(null);
  const handle = useRef<ExportHandle | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const running = progress !== null;

  const range = rangeText === null ? null : parsePageRanges(rangeText, numPages);
  const shownRange = rangeText ?? formatPageRanges(selected);

  const close = () => {
    handle.current?.cancel();
    setOpen(false);
  };

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('input,button')?.focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, []);
  useEffect(() => () => handle.current?.cancel(), []);

  const setPages = (pages: Iterable<number>) => {
    setSelected(new Set(pages));
    setRangeText(null);
  };
  const togglePage = (p: number, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(p);
    else next.delete(p);
    setPages(next);
  };
  const docPages = (d: (typeof docs)[number]) => Array.from({ length: d.numPages }, (_, i) => d.pageOffset + i + 1);

  // CSV filters: categories actually used.
  const usedCats = useMemo(() => {
    const keys = new Set(measurements.filter((m) => !isMarkupKind(m.kind) && kindOf(m) !== 'deduct').map(categoryKey));
    return [...keys].sort(
      (a, b) =>
        (categories.findIndex((c) => c.id === a) + 1 || 1e9) - (categories.findIndex((c) => c.id === b) + 1 || 1e9) || (a ? -1 : 1),
    );
  }, [measurements, categories]);

  const selectedCount = selected.size;
  const selectedMeasurements = measurements.filter((m) => selected.has(m.page)).length;
  const selectedItems = measurements.filter((m) => selected.has(m.page) && !isMarkupKind(m.kind) && isItem(m)).length;
  const noItemsHint = (
    <span className="block text-[11px] text-amber-400" data-testid="export-no-items">
      אין פריטים בדפים שנבחרו — פריט הוא ספירה, או שטח / אורך שסומן כפריט
    </span>
  );

  const doExport = () => {
    if (running) return;
    if (range && !range.ok) return;
    if (!selectedCount) {
      setMessage({ kind: 'error', text: 'בחר לפחות דף אחד' });
      return;
    }
    if (format === 'pdf' && !Object.values(pdfOpts).some(Boolean)) {
      setMessage({ kind: 'error', text: 'בחר לפחות סוג תוכן אחד' });
      return;
    }
    setMessage(null);
    setProgress({ frac: 0, text: 'מתחיל…' });
    const h = startExport(
      { format, pages: [...selected], pdf: pdfOpts, csv: csvOpts, fileName, usePicker: usePicker && pickerOk },
      (frac, text) => setProgress({ frac, text }),
    );
    handle.current = h;
    h.promise.then(
      (r) => {
        if (handle.current !== h) return;
        handle.current = null;
        setProgress(null);
        const kb = r.bytes > 1024 * 1024 ? `${(r.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(r.bytes / 1024))} KB`;
        setMessage({ kind: 'ok', text: `הקובץ ${r.fileName} נוצר (${kb})${r.how === 'picker' ? ' ונשמר' : ' והורד'}`, file: { blob: r.blob, name: r.fileName } });
      },
      (e: unknown) => {
        if (handle.current !== h) return;
        handle.current = null;
        setProgress(null);
        const aborted = (e as { name?: string })?.name === 'AbortError';
        setMessage(aborted ? { kind: 'error', text: 'הייצוא בוטל' } : { kind: 'error', text: `הייצוא נכשל: ${(e as Error)?.message ?? e}` });
      },
    );
  };

  const cancel = () => {
    handle.current?.cancel();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-2 backdrop-blur-sm sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !running && close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="ייצוא"
        dir="rtl"
        data-testid="export-dialog"
        // Keep viewer / tool shortcuts from firing while the dialog has focus.
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            if (running) cancel();
            else close();
          }
        }}
        className="flex max-h-[calc(100dvh-1rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-600/80 bg-slate-800 text-slate-200 shadow-2xl shadow-black/60"
      >
        <header className="flex items-center gap-3 border-b border-slate-700 bg-slate-800/80 px-5 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-600/20 text-sky-300">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-tight text-white">ייצוא</h2>
            <p className="truncate text-xs text-slate-400" data-testid="export-subtitle">
              {docs.length === 1 ? <span dir="auto">{docs[0].name}</span> : `${docs.length} קבצים`} · {numPages} דפים · {measurements.filter((m) => !isMarkupKind(m.kind)).length} מדידות
            </p>
          </div>
          <button type="button" aria-label="סגור" onClick={close} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white">
            <IconX />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div role="radiogroup" aria-label="יעד הייצוא" className="grid grid-cols-2 gap-2 border-b border-slate-700/70 bg-slate-900/30 px-5 py-4 sm:grid-cols-4">
            {DESTS.map((d) => {
              const on = dest === d.id;
              return (
                <label
                  key={d.id}
                  className={
                    'relative flex cursor-pointer flex-col gap-1.5 rounded-xl border p-3 transition-colors ' +
                    (on ? 'border-transparent bg-slate-700/70 shadow-lg' : 'border-slate-700 bg-slate-800/60 hover:border-slate-500 hover:bg-slate-700/40')
                  }
                  style={on ? { boxShadow: `0 0 0 2px ${DEST_ACCENT[d.id]}` } : undefined}
                >
                  <input
                    type="radio"
                    name="export-format"
                    value={d.id}
                    checked={on}
                    onChange={() => {
                      setDest(d.id);
                      setMessage(null);
                      setAlooState(null);
                    }}
                    data-testid={`export-format-${d.id}`}
                    className="sr-only"
                  />
                  <span className="flex items-center gap-2">
                    <span style={{ color: DEST_ACCENT[d.id] }}>{d.icon}</span>
                    <span className="text-sm font-semibold text-white">{d.label}</span>
                    {on && (
                      <span className="ms-auto flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-slate-900" style={{ background: DEST_ACCENT[d.id] }} aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] leading-snug text-slate-400">{d.hint}</span>
                </label>
              );
            })}
          </div>

        <div className="grid gap-4 p-5 md:grid-cols-2">
          {/* pages */}
          <div className="flex min-w-0 flex-col gap-4">
            <Section
              step={1}
              title="דפים"
              aside={
                <span className="text-xs text-slate-400" data-testid="export-selected-count">
                  נבחרו {selectedCount} מתוך {numPages}
                </span>
              }
            >
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className={chipBtn} onClick={() => setPages(Array.from({ length: numPages }, (_, i) => i + 1))}>
                  הכל
                </button>
                <button type="button" className={chipBtn} onClick={() => setPages([])}>
                  ללא
                </button>
                <button type="button" className={chipBtn} onClick={() => setPages([currentPage])}>
                  הדף הנוכחי ({currentPage})
                </button>
                <button type="button" className={chipBtn} disabled={!pagesWithData.length} onClick={() => setPages(pagesWithData)}>
                  רק דפים עם מדידות
                </button>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <span className="shrink-0 text-slate-400">טווח:</span>
                <input
                  type="text"
                  dir="ltr"
                  value={shownRange}
                  placeholder="1-3,7"
                  data-testid="export-range"
                  onChange={(e) => {
                    const t = e.target.value;
                    setRangeText(t);
                    const r = parsePageRanges(t, numPages);
                    if (r.ok) setSelected(new Set(r.pages));
                  }}
                  onBlur={() => range?.ok && setRangeText(null)}
                  className={
                    'h-8 w-full rounded border bg-slate-900 px-2 font-mono text-sm text-slate-100 focus:outline-none ' +
                    (range && !range.ok ? 'border-red-500' : 'border-slate-600 focus:border-sky-500')
                  }
                />
              </label>
              {range && !range.ok && <p className="text-xs text-red-400">{range.error}</p>}

              <div className="flex max-h-72 flex-col gap-2 overflow-y-auto rounded border border-slate-700 bg-slate-900/50 p-2" data-testid="export-tree">
                {docs.map((d) => {
                  const pages = docPages(d);
                  const n = pages.filter((p) => selected.has(p)).length;
                  const isOpen = expanded.has(d.id);
                  return (
                    <div key={d.id} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={isOpen ? 'כווץ' : 'הרחב'}
                          aria-expanded={isOpen}
                          onClick={() => {
                            const next = new Set(expanded);
                            if (isOpen) next.delete(d.id);
                            else next.add(d.id);
                            setExpanded(next);
                          }}
                          className="w-5 rounded text-xs text-slate-400 hover:bg-slate-700"
                        >
                          {isOpen ? '▾' : '◂'}
                        </button>
                        <Check
                          checked={n === pages.length}
                          indeterminate={n > 0 && n < pages.length}
                          testId={`export-doc-${d.id}`}
                          onChange={(on) => {
                            const next = new Set(selected);
                            for (const p of pages) on ? next.add(p) : next.delete(p);
                            setPages(next);
                          }}
                        >
                          <span className="truncate font-medium" dir="auto" title={d.name}>
                            {d.name}
                          </span>
                        </Check>
                        <span className="ms-auto shrink-0 text-xs text-slate-500">
                          {n}/{pages.length}
                        </span>
                      </div>
                      {isOpen && (
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(3.5rem,1fr))] gap-1 ps-6">
                          {pages.map((p) => {
                            const cnt = perPage.get(p) ?? 0;
                            const on = selected.has(p);
                            return (
                              <label
                                key={p}
                                title={`דף ${p}${docs.length > 1 ? ` (עמ׳ ${p - d.pageOffset} בקובץ)` : ''}${cnt ? ` · ${cnt} מדידות` : ''}`}
                                className={
                                  'relative flex cursor-pointer items-center justify-center gap-1 rounded border px-1 py-1 text-xs tabular-nums ' +
                                  (on ? 'border-sky-500 bg-sky-900/50 text-white' : 'border-slate-700 text-slate-400 hover:border-slate-500')
                                }
                              >
                                <input
                                  type="checkbox"
                                  className="sr-only"
                                  checked={on}
                                  data-testid={`export-page-${p}`}
                                  onChange={(e) => togglePage(p, e.target.checked)}
                                />
                                {p}
                                {cnt > 0 && <span className="absolute -top-1 left-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-500">
                <span className="me-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 align-middle" /> דף עם מדידות · כל הדפים
                שנבחרו (גם מכמה קבצים) ייצאו לקובץ אחד, לפי הסדר.
              </p>
            </Section>
          </div>

          {/* content + file / ALOO */}
          <div className="flex min-w-0 flex-col gap-4">
            {dest === 'aloo' ? (
              <AlooPanel pages={selected} />
            ) : format === 'xlsx' ? (
              <XlsxSummary pages={selected} />
            ) : format === 'pdf' ? (
              <Section step={2} title="תוכן ה־PDF">
                {PDF_CONTENT.map((o) => (
                  <Check
                    key={o.id}
                    checked={pdfOpts[o.id]}
                    testId={`export-pdf-${o.id}`}
                    disabled={o.id === 'legend' && !pdfOpts.measurements && !pdfOpts.summary}
                    onChange={(v) => setPdfOpts({ ...pdfOpts, [o.id]: v })}
                  >
                    {o.label}
                    {o.hint && <span className="block text-[11px] text-slate-500">{o.hint}</span>}
                    {o.id === 'items' && pdfOpts.items && !selectedItems && noItemsHint}
                  </Check>
                ))}
              </Section>
            ) : (
              <>
                <Section step={2} title="תוכן ה־CSV">
                  {CSV_SECTIONS.map((o) => (
                    <Check key={o.id} checked={csvOpts[o.id]} testId={`export-csv-${o.id}`} onChange={(v) => setCsvOpts({ ...csvOpts, [o.id]: v })}>
                      {o.label}
                      {o.id === 'items' && csvOpts.items && !selectedItems && noItemsHint}
                    </Check>
                  ))}
                </Section>
                <Section title="סינון לפי סוג">
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {KIND_OPTIONS.map((k) => (
                      <Check
                        key={k.id}
                        checked={csvOpts.kinds.includes(k.id)}
                        testId={`export-kind-${k.id}`}
                        onChange={(v) =>
                          setCsvOpts({ ...csvOpts, kinds: v ? [...csvOpts.kinds, k.id] : csvOpts.kinds.filter((x) => x !== k.id) })
                        }
                      >
                        {k.label}
                      </Check>
                    ))}
                  </div>
                </Section>
                {usedCats.length > 0 && (
                  <Section
                    title="סינון לפי קטגוריה"
                    aside={
                      <span className="flex gap-1">
                        <button type="button" className={linkBtn} onClick={() => setCsvOpts({ ...csvOpts, categories: null })}>
                          הכל
                        </button>
                        <button type="button" className={linkBtn} onClick={() => setCsvOpts({ ...csvOpts, categories: [] })}>
                          ללא
                        </button>
                      </span>
                    }
                  >
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {usedCats.map((k) => {
                        const on = csvOpts.categories === null || csvOpts.categories.includes(k);
                        const color = categories.find((c) => c.id === k)?.color ?? '#94a3b8';
                        return (
                          <Check
                            key={k || '_none'}
                            checked={on}
                            onChange={(v) => {
                              const cur = csvOpts.categories ?? usedCats;
                              const next = v ? [...new Set([...cur, k])] : cur.filter((x) => x !== k);
                              setCsvOpts({ ...csvOpts, categories: next.length === usedCats.length ? null : next });
                            }}
                          >
                            <span className="me-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: color }} />
                            {categoryName(k, categories)}
                          </Check>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-slate-500">ניכויים נכללים עם הקטגוריה של השטח שבו הם נמצאים.</p>
                  </Section>
                )}
              </>
            )}

            {dest !== 'aloo' && (
            <Section step={3} title="שמירה">
              <label className="flex items-center gap-2 text-sm">
                <span className="shrink-0 text-slate-400">שם:</span>
                <input
                  type="text"
                  dir="auto"
                  value={fileName}
                  data-testid="export-filename"
                  onChange={(e) => setFileName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && doExport()}
                  className="h-8 min-w-0 flex-1 rounded border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                />
                <span className="font-mono text-xs text-slate-400">.{format}</span>
              </label>
              {pickerOk && (
                <Check checked={usePicker} onChange={setUsePicker} testId="export-picker">
                  לשאול היכן לשמור
                </Check>
              )}
            </Section>
            )}
          </div>
        </div>
        </div>

        <footer className="flex flex-col gap-2 border-t border-slate-700 bg-slate-800/95 px-5 py-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}>
          {progress && (
            <div className="flex flex-col gap-1" role="status" data-testid="export-progress">
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
                <div className="h-full rounded-full bg-sky-500 transition-[width] duration-200" style={{ width: `${Math.round(progress.frac * 100)}%` }} />
              </div>
              <span className="text-xs text-slate-300">
                {progress.text} · {Math.round(progress.frac * 100)}%
              </span>
            </div>
          )}
          {message && (
            <p
              role={message.kind === 'error' ? 'alert' : 'status'}
              data-testid="export-message"
              className={'text-sm ' + (message.kind === 'ok' ? 'text-emerald-300' : 'text-red-400')}
            >
              {message.text}
              {message.file && (
                <button
                  type="button"
                  onClick={() => openExportedFile(message.file!.blob, message.file!.name)}
                  data-testid="export-open"
                  className="ms-2 inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-0.5 text-xs font-semibold text-white hover:bg-emerald-500"
                >
                  פתח
                </button>
              )}
            </p>
          )}
          {alooState && (
            <p role={alooState.kind === 'error' ? 'alert' : 'status'} data-testid="aloo-message" className={'text-sm ' + (alooState.kind === 'ok' ? 'text-emerald-300' : 'text-red-400')}>
              {alooState.text}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="me-auto text-xs text-slate-400" data-testid="export-footer-summary">
              {selectedCount} דפים · {dest === 'aloo' ? `${alooItemsOn(selected).length} פריטים` : `${selectedMeasurements} מדידות וסימונים`}
            </span>
            {running ? (
              <button type="button" onClick={cancel} data-testid="export-cancel" className="h-9 rounded-lg border border-slate-600 px-4 text-sm hover:bg-slate-700">
                בטל
              </button>
            ) : (
              <button type="button" onClick={close} className="h-9 rounded-lg border border-slate-600 px-4 text-sm text-slate-300 hover:bg-slate-700">
                סגור
              </button>
            )}
            {dest === 'aloo' ? (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    const p = alooPayload(selected);
                    if (!p.measurements.length) return;
                    sendToAloo(p, { shiftKey: e.shiftKey });
                  }}
                  disabled={!alooItemsOn(selected).length}
                  data-testid="aloo-open"
                  title="פותח את מסך הייבוא ב-ALOO עם הפריטים (Shift+לחיצה: שינוי כתובת ALOO)"
                  className="h-9 rounded-lg border border-violet-500/70 px-4 text-sm font-medium text-violet-200 hover:bg-violet-900/40 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  פתח ב-ALOO
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const p = alooPayload(selected);
                    if (!p.measurements.length) return;
                    const ok = await copyText(buildAlooTsv(p));
                    setAlooState(
                      ok
                        ? { kind: 'ok', text: `✓ הועתקו ${p.measurements.length} פריטים — ב-ALOO: פרויקט ← ייבוא מדידות ← "הדבק מהלוח"` }
                        : { kind: 'error', text: 'הדפדפן לא איפשר להעתיק ללוח. נסה שוב, או השתמש ב"פתח ב-ALOO".' },
                    );
                  }}
                  disabled={!alooItemsOn(selected).length}
                  data-testid="aloo-copy"
                  className="flex h-9 items-center gap-1.5 rounded-lg bg-violet-600 px-5 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <DestIcon kind="aloo" />
                  ייצא ל-ALOO
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={doExport}
                disabled={running || !selectedCount || (range !== null && !range.ok)}
                data-testid="export-run"
                className="h-9 rounded-lg bg-sky-600 px-6 text-sm font-semibold text-white shadow-lg shadow-sky-900/40 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ייצא {DESTS.find((d) => d.id === dest)?.label}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Excel: what the workbook will contain + how many item rows the selected pages have. */
function XlsxSummary({ pages }: { pages: Set<number> }) {
  const measurements = useViewer((s) => persistentMeasurements(s.measurements));
  const itemCount = useMemo(() => measurements.filter((m) => pages.has(m.page) && !isMarkupKind(m.kind) && isItem(m)).length, [measurements, pages]);
  return (
    <Section title="תוכן קובץ ה־Excel">
      <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm text-slate-300">
        <li>
          <b className="text-slate-100">טבלת פריטים</b> — שם פריט, קטגוריה, מערכת, גודל, כמות ויחידה, מידע נוסף; סה״כ לכל קטגוריה וסה״כ כללי
        </li>
        <li>
          <b className="text-slate-100">מדידות</b> — כל המדידות (כמו ה־CSV) כולל מידות פריטים
        </li>
        <li>
          <b className="text-slate-100">הערות</b> — הערות וטקסטים מהשרטוט
        </li>
      </ul>
      <div className="rounded border border-slate-700 bg-slate-900/50 p-2 text-xs text-slate-400" data-testid="export-xlsx-summary">
        {itemCount} פריטים בטבלת הפריטים בדפים שנבחרו
      </div>
    </Section>
  );
}

/** Takeoff items (area / opening / length / count) of the selected pages, as ALOO receives them. */
function alooPayload(pages: Set<number>): GilboaPayload {
  const s = useViewer.getState();
  const ms = persistentMeasurements(s.measurements).filter((m) => pages.has(m.page));
  return buildGilboaPayload(ms, s.calibrations, s.categories, s.fileName);
}
const alooItemsOn = (pages: Set<number>) => alooPayload(pages).measurements;

const fmt = (v: number | null, unit: string) => (v == null ? '' : `${Math.round(v * 100) / 100} ${unit}`);

/** ALOO: what will be copied (preview) and how to paste it. */
function AlooPanel({ pages }: { pages: Set<number> }) {
  // Re-render on measurement changes.
  useViewer((s) => s.measurements);
  const items = alooItemsOn(pages);
  const byKind = items.reduce<Record<string, number>>((m, x) => ((m[x.kind] = (m[x.kind] ?? 0) + 1), m), {});
  const noSize = items.filter((x) => x.kind !== 'count' && x.areaM2 == null && x.lengthM == null).length;
  return (
    <>
      <Section
        step={2}
        title="פריטים ל-ALOO"
        aside={
          <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-xs font-semibold text-violet-200" data-testid="aloo-count">
            {items.length} פריטים
          </span>
        }
      >
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-600 p-4 text-center text-sm text-slate-400" data-testid="aloo-empty">
            אין פריטים בדפים שנבחרו.
            <span className="mt-1 block text-xs text-slate-500">פריטים הם מדידות שנשמרו במצב עריכה: שטח, פתח, אורך או ספירה.</span>
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {(['area', 'deduct', 'length', 'count'] as const).map(
                (k) =>
                  byKind[k] > 0 && (
                    <span key={k} className="rounded-full border border-slate-600 px-2 py-0.5 text-slate-300">
                      {ALOO_KIND_LABEL[k]} · {byKind[k]}
                    </span>
                  ),
              )}
            </div>
            <div className="max-h-56 overflow-auto rounded-lg border border-slate-700" data-testid="aloo-preview">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-800 text-slate-400">
                  <tr>
                    <th className="px-2 py-1.5 text-start font-medium">סוג</th>
                    <th className="px-2 py-1.5 text-start font-medium">שם</th>
                    <th className="px-2 py-1.5 text-start font-medium">קטגוריה</th>
                    <th className="px-2 py-1.5 text-start font-medium">מידות / כמות</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((x, i) => (
                    <tr key={i} className="border-t border-slate-700/70">
                      <td className="whitespace-nowrap px-2 py-1 text-slate-300">{ALOO_KIND_LABEL[x.kind]}</td>
                      <td className="max-w-[9rem] truncate px-2 py-1 text-slate-100" dir="auto" title={x.label}>
                        {x.label}
                      </td>
                      <td className="max-w-[7rem] truncate px-2 py-1 text-slate-400" dir="auto">
                        {x.category || '—'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-[11px] text-slate-300" dir="ltr">
                        {x.kind === 'count'
                          ? `× ${x.count}`
                          : x.kind === 'length'
                            ? fmt(x.lengthM, 'm') || '—'
                            : x.widthM != null
                              ? `${fmt(x.widthM, '')}× ${fmt(x.heightM, 'm')}`
                              : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {noSize > 0 && (
              <p className="text-[11px] text-amber-400" data-testid="aloo-uncalibrated">
                {noSize} פריטים בדפים שלא כוילו — יועתקו בלי מידות (כייל את הדף כדי לקבל מידות מדויקות).
              </p>
            )}
          </>
        )}
      </Section>
      <Section step={3} title="איך מדביקים ב-ALOO">
        <ol className="flex list-decimal flex-col gap-1 ps-5 text-[13px] text-slate-300">
          <li>
            לוחצים <b className="text-violet-200">ייצא ל-ALOO</b> — הפריטים מועתקים ללוח (עם מידות מדויקות).
          </li>
          <li>ב-ALOO פותחים את הפרויקט ← ייבוא מדידות.</li>
          <li>
            לוחצים <b className="text-slate-100">📋 הדבק מהלוח</b>, בודקים ומאשרים.
          </li>
        </ol>
        <p className="text-[11px] text-slate-500">אפשר גם להדביק את הטבלה ב-Excel. "פתח ב-ALOO" שולח את הפריטים ישירות למסך הייבוא.</p>
      </Section>
    </>
  );
}
