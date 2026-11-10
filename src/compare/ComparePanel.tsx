import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../state/store';
import { useFileQueue } from '../state/fileQueue';
import { docIdAtPage } from '../state/editMode';
import { IconX } from '../components/ui/icons';
import { changedGlobalPages, runCompare } from './runCompare';
import { changesOnPage, clearCompare, closeCompareDialog, compareTotals, useCompare } from './compareStore';

/** Two-files icon (version compare). */
export function IconCompare({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" />
      <path d="M12 2v20" />
      <path d="M7 9l-2 3 2 3" />
      <path d="M17 9l2 3-2 3" />
    </svg>
  );
}

/**
 * "השוואת גרסאות" dialog: pick the previous and the new version among the
 * open files, or open the previous version from disk (it is added as a tab).
 */
export function CompareDialog() {
  const open = useCompare((s) => s.dialogOpen);
  const docs = useViewer((s) => s.docs);
  const currentPage = useViewer((s) => s.currentPage);
  const activeId = docIdAtPage(docs, currentPage);
  const [newId, setNewId] = useState<string | null>(null);
  const [oldId, setOldId] = useState<string | null>(null);
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Defaults when opened: new = the file on screen, old = another open file.
  useEffect(() => {
    if (!open) return;
    const n = activeId ?? docs[docs.length - 1]?.id ?? null;
    setNewId(n);
    setOldId(docs.find((d) => d.id !== n)?.id ?? null);
    setWaitingFor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A file picked from disk becomes the previous version once it is open.
  useEffect(() => {
    if (!waitingFor) return;
    const d = docs.find((x) => x.name === waitingFor && x.id !== newId && !knownIds.current.has(x.id));
    if (d) {
      setOldId(d.id);
      setWaitingFor(null);
    }
  }, [docs, waitingFor, newId]);
  const knownIds = useRef(new Set<string>());

  if (!open) return null;
  const name = (id: string | null) => docs.find((d) => d.id === id)?.name ?? '';
  const canRun = !!oldId && !!newId && oldId !== newId && !waitingFor;

  const select = (value: string | null, onChange: (v: string) => void, testId: string, exclude: string | null) => (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
      dir="auto"
      className="h-10 w-full rounded-md border border-slate-600 bg-slate-900 px-2 text-base text-slate-100 focus:border-pink-500 focus:outline-none sm:text-sm"
    >
      <option value="" disabled>
        בחר קובץ…
      </option>
      {docs.map((d) => (
        <option key={d.id} value={d.id} disabled={d.id === exclude}>
          {d.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" onPointerDown={(e) => e.target === e.currentTarget && closeCompareDialog()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="השוואת גרסאות"
        dir="rtl"
        data-testid="compare-dialog"
        className="w-full max-w-md rounded-xl border border-pink-500/40 bg-slate-800 p-4 text-slate-100 shadow-2xl shadow-pink-900/30"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') closeCompareDialog();
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-pink-400">
            <IconCompare />
          </span>
          <h2 className="flex-1 text-base font-bold">השוואת גרסאות</h2>
          <button type="button" onClick={closeCompareDialog} aria-label="סגור" className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-white">
            <IconX size={16} />
          </button>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-slate-400">
          האזורים שהשתנו יסומנו במרקר זוהר בשתי הגרסאות, ולכל דף יוצג מספר השינויים. הדפים מושווים לפי הסדר (דף 1 מול דף 1 וכן הלאה).
        </p>
        <label className="mb-1 block text-xs font-semibold text-slate-300">גרסה חדשה</label>
        {select(newId, setNewId, 'compare-new', oldId)}
        <label className="mb-1 mt-3 block text-xs font-semibold text-slate-300">גרסה קודמת</label>
        {select(oldId, setOldId, 'compare-old', newId)}
        <button
          type="button"
          data-testid="compare-pick-old"
          onClick={() => fileInput.current?.click()}
          className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-pink-500/60 bg-pink-950/30 text-xs font-semibold text-pink-200 hover:border-pink-400 hover:bg-pink-900/40"
        >
          {waitingFor ? (
            <>
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-pink-300/40 border-t-pink-300" aria-hidden="true" />
              פותח את <span dir="auto">{waitingFor}</span>…
            </>
          ) : (
            'פתח קובץ של הגרסה הקודמת…'
          )}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          data-testid="compare-old-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            knownIds.current = new Set(useViewer.getState().docs.map((d) => d.id));
            setWaitingFor(f.name);
            useFileQueue.getState().addFiles([f]);
          }}
        />
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            data-testid="compare-run"
            disabled={!canRun}
            onClick={() => oldId && newId && void runCompare(oldId, newId)}
            className="h-10 flex-1 rounded-md bg-gradient-to-l from-pink-600 to-fuchsia-600 text-sm font-bold text-white shadow-lg shadow-pink-900/40 hover:from-pink-500 hover:to-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            השווה
          </button>
          <button type="button" onClick={closeCompareDialog} className="h-10 rounded-md px-4 text-sm text-slate-300 hover:bg-slate-700">
            ביטול
          </button>
        </div>
        {canRun && (
          <p className="mt-2 truncate text-center text-[11px] text-slate-500">
            <span dir="auto">{name(oldId)}</span> ← <span dir="auto">{name(newId)}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Floating bar while a compare is shown: progress, changes on this page and in
 * total, previous / next changed page, jump to the same page in the other
 * version, show / hide the highlights, close.
 */
export function CompareBar() {
  const status = useCompare((s) => s.status);
  const progress = useCompare((s) => s.progress);
  const visible = useCompare((s) => s.visible);
  const oldId = useCompare((s) => s.oldId);
  const newId = useCompare((s) => s.newId);
  const regions = useCompare((s) => s.regions);
  const notes = useCompare((s) => s.notes);
  const totals = compareTotals({ regions, notes, oldId, newId });
  const docs = useViewer((s) => s.docs);
  const currentPage = useViewer((s) => s.currentPage);
  const setPage = useViewer((s) => s.setPage);
  const activeId = docIdAtPage(docs, currentPage);
  const doc = docs.find((d) => d.id === activeId);
  const local = doc ? currentPage - doc.pageOffset : 0;
  const here = useCompare((s) => (activeId ? changesOnPage(s, activeId, local) : 0));

  // A compared file was closed → the compare ends.
  useEffect(() => {
    if (status === 'idle') return;
    if (!docs.some((d) => d.id === oldId) || !docs.some((d) => d.id === newId)) clearCompare();
  }, [docs, oldId, newId, status]);

  if (status === 'idle') return null;
  const onCompared = activeId === oldId || activeId === newId;
  const pages = activeId && onCompared ? changedGlobalPages(activeId) : [];
  const prev = [...pages].reverse().find((p) => p < currentPage);
  const next = pages.find((p) => p > currentPage);
  const other = activeId === newId ? oldId : newId;
  const otherDoc = docs.find((d) => d.id === other);
  const goOther = () => {
    if (!otherDoc) return;
    setPage(otherDoc.pageOffset + Math.min(Math.max(1, local || 1), otherDoc.numPages));
  };
  const btn =
    'flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-xs font-semibold text-pink-100 hover:bg-pink-500/25 disabled:opacity-35 disabled:hover:bg-transparent';

  return (
    <div
      dir="rtl"
      data-testid="compare-bar"
      data-status={status}
      className="absolute left-1/2 top-14 z-30 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-full border border-pink-500/60 bg-slate-900/90 p-1 text-pink-50 shadow-[0_0_18px_rgba(255,42,149,0.45)] backdrop-blur [scrollbar-width:none]"
    >
      <span className="flex shrink-0 items-center gap-1 ps-2 text-pink-300">
        <IconCompare size={16} />
      </span>
      {status === 'running' && (
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-1 text-xs" data-testid="compare-progress">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-pink-300/40 border-t-pink-300" aria-hidden="true" />
          משווה דף {Math.min(progress.done + 1, progress.total)} מתוך {progress.total}
        </span>
      )}
      {status === 'error' && <span className="shrink-0 whitespace-nowrap px-1 text-xs text-red-300">ההשוואה נכשלה</span>}
      {onCompared && (
        <span className="shrink-0 whitespace-nowrap rounded-full bg-pink-600/80 px-2.5 py-1 text-xs font-bold text-white" data-testid="compare-here">
          {activeId === newId ? 'חדשה' : 'קודמת'} · דף {local}: {here === 0 ? 'ללא שינויים' : here === 1 ? 'שינוי אחד' : `${here} שינויים`}
        </span>
      )}
      {status === 'done' && (
        <span className="shrink-0 whitespace-nowrap px-1.5 text-xs text-pink-200" data-testid="compare-total">
          סה״כ {totals.changes} שינויים ב-{totals.pages} דפים
        </span>
      )}
      {onCompared && (
        <>
          <button type="button" className={btn} disabled={prev == null} onClick={() => prev != null && setPage(prev)} aria-label="דף שינוי קודם" title="דף שינוי קודם" data-testid="compare-prev">
            ›
          </button>
          <button type="button" className={btn} disabled={next == null} onClick={() => next != null && setPage(next)} aria-label="דף שינוי הבא" title="דף שינוי הבא" data-testid="compare-next">
            ‹
          </button>
        </>
      )}
      {otherDoc && (
        <button type="button" className={btn + ' whitespace-nowrap'} onClick={goOther} data-testid="compare-swap" title="אותו דף בגרסה השנייה">
          {activeId === newId ? 'לגרסה הקודמת' : 'לגרסה החדשה'}
        </button>
      )}
      <button
        type="button"
        className={btn}
        onClick={() => useCompare.setState({ visible: !visible })}
        aria-pressed={!visible}
        data-testid="compare-toggle"
        title={visible ? 'הסתר סימון' : 'הצג סימון'}
      >
        {visible ? 'הסתר' : 'הצג'}
      </button>
      <button type="button" className={btn} onClick={clearCompare} aria-label="סגור השוואה" title="סגור השוואה" data-testid="compare-close">
        <IconX size={14} />
      </button>
    </div>
  );
}
