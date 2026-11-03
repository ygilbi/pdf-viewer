import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useViewer } from '../state/store';
import { categoryKey, categoryName, isMarkupKind, kindOf } from '../core/measurementEngine';
import { useExportUi } from '../export/exportUi';
import { formatPageRanges, parsePageRanges } from '../export/pageSelection';
import { savePickerSupported, startExport, type ExportHandle } from '../export/runExport';
import { DEFAULT_CSV_OPTIONS, DEFAULT_PDF_OPTIONS, type CsvOptions, type ExportFormat, type PdfContentOptions } from '../export/types';
import { baseName } from './ui/util';
import { IconX } from './ui/icons';
import { boqForPages } from '../export/runExport';
import { formatMoney } from '../pricing/boq';
import { usePricing } from '../pricing/store';

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
  { id: 'calibration', label: 'קו כיול' },
  { id: 'summary', label: 'טבלאות סיכום בסוף', hint: 'לפי עמוד ולפי קטגוריה, סה״כ, רשימת הערות' },
  { id: 'legend', label: 'מקרא קטגוריות' },
  { id: 'boq', label: 'כתב כמויות עם מחירים', hint: 'עמוד תמחור: כמות, פחת, מחיר, הנחה ומע״מ (לפי חלונית התמחור)' },
];

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'pdf', label: 'PDF', hint: 'שרטוט + מדידות' },
  { id: 'xlsx', label: 'Excel', hint: 'מומלץ לתמחור' },
  { id: 'csv', label: 'CSV', hint: 'טבלה פשוטה' },
];

const CSV_SECTIONS: { id: 'rows' | 'categoryTotals' | 'totals' | 'notes'; label: string }[] = [
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

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
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
  const measurements = useViewer((s) => s.measurements);
  const categories = useViewer((s) => s.categories);

  const perPage = useMemo(() => {
    const m = new Map<number, number>();
    for (const x of measurements) m.set(x.page, (m.get(x.page) ?? 0) + 1);
    return m;
  }, [measurements]);
  const pagesWithData = useMemo(() => [...perPage.keys()].sort((a, b) => a - b), [perPage]);

  const [format, setFormat] = useState<ExportFormat>(() => useExportUi.getState().format ?? 'pdf');
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
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
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
        setMessage({ kind: 'ok', text: `הקובץ ${r.fileName} נוצר (${kb})${r.how === 'picker' ? ' ונשמר' : ' והורד'}` });
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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-2 sm:p-4"
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
        className="flex max-h-[calc(100vh-1rem)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-slate-600 bg-slate-800 text-slate-200 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-slate-700 px-4 py-2.5">
          <h2 className="text-base font-semibold">ייצוא</h2>
          <button type="button" aria-label="סגור" onClick={close} className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-white">
            <IconX />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-4 md:grid-cols-2">
          {/* left column (in RTL: right): format + pages */}
          <div className="flex min-w-0 flex-col gap-5">
            <Section title="פורמט">
              <div role="radiogroup" aria-label="פורמט" className="flex gap-2">
                {FORMATS.map((f) => (
                  <label
                    key={f.id}
                    className={
                      'flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-sm ' +
                      (format === f.id ? 'border-sky-500 bg-sky-900/40 text-white' : 'border-slate-600 hover:bg-slate-700')
                    }
                  >
                    <input
                      type="radio"
                      name="export-format"
                      value={f.id}
                      checked={format === f.id}
                      onChange={() => setFormat(f.id)}
                      data-testid={`export-format-${f.id}`}
                      className="accent-sky-500"
                    />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="font-medium">{f.label}</span>
                      <span className={'truncate text-[11px] ' + (f.id === 'xlsx' ? 'text-emerald-300' : 'text-slate-400')}>
                        {f.id === 'xlsx' ? `(${f.hint})` : f.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </Section>

            <Section
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

          {/* right column: content + file */}
          <div className="flex min-w-0 flex-col gap-5">
            {format === 'xlsx' ? (
              <XlsxSummary pages={selected} />
            ) : format === 'pdf' ? (
              <Section title="תוכן ה־PDF">
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
                  </Check>
                ))}
              </Section>
            ) : (
              <>
                <Section title="תוכן ה־CSV">
                  {CSV_SECTIONS.map((o) => (
                    <Check key={o.id} checked={csvOpts[o.id]} testId={`export-csv-${o.id}`} onChange={(v) => setCsvOpts({ ...csvOpts, [o.id]: v })}>
                      {o.label}
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

            <Section title="קובץ">
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
              <p className="text-xs text-slate-400">
                {selectedCount} דפים · {selectedMeasurements} מדידות וסימונים
              </p>
            </Section>
          </div>
        </div>

        <footer className="flex flex-col gap-2 border-t border-slate-700 px-4 py-3">
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
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={doExport}
              disabled={running || !selectedCount || (range !== null && !range.ok)}
              data-testid="export-run"
              className="rounded-md bg-sky-600 px-5 py-1.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ייצא
            </button>
            {running ? (
              <button type="button" onClick={cancel} data-testid="export-cancel" className="rounded-md border border-slate-600 px-4 py-1.5 text-sm hover:bg-slate-700">
                בטל
              </button>
            ) : (
              <button type="button" onClick={close} className="rounded-md border border-slate-600 px-4 py-1.5 text-sm hover:bg-slate-700">
                סגור
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Excel: what the workbook will contain + the live BOQ total for the selected pages. */
function XlsxSummary({ pages }: { pages: Set<number> }) {
  const measurements = useViewer((s) => s.measurements);
  const calibrations = useViewer((s) => s.calibrations);
  const categories = useViewer((s) => s.categories);
  const docPrices = usePricing((s) => s.doc);
  const globalPrices = usePricing((s) => s.global);
  const boq = useMemo(
    () => boqForPages({ measurements, calibrations, categories }, pages),
    // boqForPages reads the (subscribed) price book itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [measurements, calibrations, categories, pages, docPrices, globalPrices],
  );
  return (
    <Section title="תוכן קובץ ה־Excel">
      <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm text-slate-300">
        <li>
          <b className="text-slate-100">כתב כמויות</b> — שורה לכל קטגוריה עם נוסחאות חיות: כמות × (1 + פחת) × מחיר, סה״כ, הנחה, מע״מ
        </li>
        <li>
          <b className="text-slate-100">מדידות</b> — כל המדידות (כמו ה־CSV) כולל מידות פריטים
        </li>
        <li>
          <b className="text-slate-100">הערות</b> — הערות וטקסטים מהשרטוט
        </li>
      </ul>
      <div className="rounded border border-slate-700 bg-slate-900/50 p-2 text-xs" data-testid="export-xlsx-summary">
        <div className="flex justify-between">
          <span className="text-slate-400">{boq.lines.length} שורות בכתב הכמויות</span>
          <span className="font-mono font-semibold text-emerald-300" dir="ltr">
            {formatMoney(boq.total, boq.currency)}
          </span>
        </div>
        {boq.warnings.map((w) => (
          <p key={w} className="mt-1 text-amber-400">
            {w}
          </p>
        ))}
        <p className="mt-1 text-slate-500">מחירים, פחת והנחה נערכים בחלונית התמחור (Q).</p>
      </div>
    </Section>
  );
}
