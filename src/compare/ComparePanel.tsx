import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../state/store';
import { useFileQueue } from '../state/fileQueue';
import { docIdAtPage } from '../state/editMode';
import { IconX } from '../components/ui/icons';
import { useCompactLayout } from '../components/shell/layout';
import { changedGlobalPages, runCompare } from './runCompare';
import { clearCompare, closeCompareDialog, compareTotals, KIND_LABEL, pageChanges, regionKind, shownRegions, useCompare, VERSION_COLOR, type CompareTotals } from './compareStore';
import type { ChangeKind, DiffRegion } from '../core/versionDiff';
import { setPendingFocus, zoomToRect } from '../components/viewer/commands';
import type { Rect } from '../core/types';

/** Go to `page` (if needed) and zoom to `rect` (same as the search results). */
function focusRect(page: number, rect: Rect) {
  const v = useViewer.getState();
  if (v.currentPage === page) zoomToRect(rect);
  else {
    setPendingFocus(page, rect);
    v.setPage(page);
  }
}

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

function IconEye({ off }: { off: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
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
          שתי הגרסאות יוצגו זו על זו — הקודמת באדום והחדשה בכחול (קווים זהים יוצאים כהים). אפשר להסתיר כל גרסה, לכבות צבעים ולגרור וילון. לכל דף יוצג מספר השינויים. הדפים מותאמים אוטומטית — גם אם נוספו או הוסרו דפים באמצע הסט.
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

const KIND_DOT: Record<ChangeKind, string> = { added: 'bg-green-500', removed: 'bg-red-500', modified: 'bg-amber-500' };
const KINDS: ChangeKind[] = ['added', 'removed', 'modified'];

/**
 * Floating bar while a compare is shown: progress, changes on this page and in
 * total, previous / next changed page, jump to the same page in the other
 * version, show / hide the highlights, details panel, close.
 */
export function CompareBar() {
  const status = useCompare((s) => s.status);
  const phase = useCompare((s) => s.phase);
  const progress = useCompare((s) => s.progress);
  const visible = useCompare((s) => s.visible);
  const panelOpen = useCompare((s) => s.panelOpen);
  const mode = useCompare((s) => s.mode);
  const oldId = useCompare((s) => s.oldId);
  const newId = useCompare((s) => s.newId);
  const regions = useCompare((s) => s.regions);
  const notes = useCompare((s) => s.notes);
  const filter = useCompare((s) => s.filter);
  const pairOf = useCompare((s) => s.pairOf);
  const totals = compareTotals({ regions, notes, oldId, newId, filter });
  const docs = useViewer((s) => s.docs);
  const currentPage = useViewer((s) => s.currentPage);
  const setPage = useViewer((s) => s.setPage);
  const activeId = docIdAtPage(docs, currentPage);
  const doc = docs.find((d) => d.id === activeId);
  const local = doc ? currentPage - doc.pageOffset : 0;
  const here = useCompare((s) => (activeId ? pageChanges(s, activeId, local) : null));
  const compact = useCompactLayout();

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
  // The matching page in the other version (content-matched when pages were inserted / deleted).
  const otherLocal = activeId ? pairOf[activeId]?.[local] : undefined;
  const goOther = () => {
    if (!otherDoc) return;
    setPage(otherDoc.pageOffset + Math.min(Math.max(1, otherLocal ?? (local || 1)), otherDoc.numPages));
  };
  const btn =
    'flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full px-2 text-xs font-semibold text-pink-100 hover:bg-pink-500/25 disabled:opacity-35 disabled:hover:bg-transparent';

  return (
    <div className="absolute left-1/2 top-14 z-30 flex w-max max-w-[calc(100%-1rem)] -translate-x-1/2 flex-col items-center gap-1.5" dir="rtl">
      <div
        data-testid="compare-bar"
        data-status={status}
        className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-pink-500/60 bg-slate-900/90 p-1 text-pink-50 shadow-[0_0_18px_rgba(255,42,149,0.45)] backdrop-blur [scrollbar-width:none]"
      >
        {!compact && (
          <span className="flex shrink-0 items-center gap-1 ps-2 text-pink-300">
            <IconCompare size={16} />
          </span>
        )}
        {status === 'running' && (
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-1 text-xs" data-testid="compare-progress">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-pink-300/40 border-t-pink-300" aria-hidden="true" />
            {phase === 'match' ? (compact ? 'מתאים ' : 'מתאים דפים ') : compact ? '' : 'משווה דף '}
            {Math.min(progress.done + 1, progress.total)}/{progress.total}
          </span>
        )}
        {status === 'error' && <span className="shrink-0 whitespace-nowrap px-1 text-xs text-red-300">ההשוואה נכשלה</span>}
        {onCompared && here != null && (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-pink-600/80 px-2.5 py-1 text-xs font-bold text-white" data-testid="compare-here">
            {activeId === newId ? 'חדשה' : 'קודמת'} · {compact ? '' : `דף ${local}: `}
            {here === 0 ? 'ללא שינויים' : here === 1 ? 'שינוי אחד' : `${here} שינויים`}
          </span>
        )}
        {status === 'done' && !compact && (
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
            ⇄ {compact ? (activeId === newId ? 'קודמת' : 'חדשה') : activeId === newId ? 'לגרסה הקודמת' : 'לגרסה החדשה'}
          </button>
        )}
        <button
          type="button"
          className={btn}
          onClick={() => useCompare.setState({ visible: !visible })}
          aria-pressed={!visible}
          aria-label={visible ? 'הסתר סימון' : 'הצג סימון'}
          data-testid="compare-toggle"
          title={visible ? 'הסתר סימון' : 'הצג סימון'}
        >
          <IconEye off={!visible} />
        </button>
        <button
          type="button"
          className={btn + (panelOpen ? ' bg-pink-500/30' : '')}
          onClick={() => useCompare.setState({ panelOpen: !panelOpen })}
          aria-expanded={panelOpen}
          aria-label="פרטי השוואה"
          title="תצוגה, סוגי שינויים ורשימה"
          data-testid="compare-details"
        >
          <IconSliders />
        </button>
        <button type="button" className={btn} onClick={clearCompare} aria-label="סגור השוואה" title="סגור השוואה" data-testid="compare-close">
          <IconX size={14} />
        </button>
      </div>
      {mode === 'layers' && visible && <VersionsRow compact={compact} oldName={docs.find((d) => d.id === oldId)?.name ?? ''} newName={docs.find((d) => d.id === newId)?.name ?? ''} />}
      {panelOpen && <CompareDetails totals={totals} done={status === 'done'} />}
    </div>
  );
}

/**
 * Forma-style "compared documents" row: each version with its colour and a show / hide toggle,
 * colours on / off, curtain on / off.
 */
function VersionsRow({ compact, oldName, newName }: { compact: boolean; oldName: string; newName: string }) {
  const layers = useCompare((s) => s.layers);
  const colors = useCompare((s) => s.colors);
  const curtain = useCompare((s) => s.curtain);
  const sharpening = useCompare((s) => s.sharpening);
  const item = (k: 'old' | 'new', name: string) => {
    const on = layers[k];
    return (
      <button
        key={k}
        type="button"
        aria-pressed={on}
        data-testid={`compare-layer-${k}`}
        title={`${on ? 'הסתר' : 'הצג'} את ה${k === 'old' ? 'גרסה הקודמת' : 'גרסה החדשה'}: ${name}`}
        onClick={() => useCompare.setState({ layers: { ...layers, [k]: !on } })}
        className={
          'flex h-9 min-w-0 shrink items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors ' +
          (on ? 'border-slate-500 bg-slate-800 text-white' : 'border-slate-700 bg-slate-900/60 text-slate-500')
        }
      >
        <span className="h-3 w-3 shrink-0 rounded-full ring-2 ring-white/30" style={{ background: colors ? VERSION_COLOR[k] : '#111', opacity: on ? 1 : 0.35 }} />
        <span className="whitespace-nowrap">{k === 'old' ? 'קודמת' : 'חדשה'}</span>
        {!compact && (
          <span className="max-w-[9rem] truncate font-normal text-slate-400" dir="auto">
            {name}
          </span>
        )}
        <IconEye off={!on} />
      </button>
    );
  };
  const tog = (on: boolean) =>
    'flex h-9 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold transition-colors ' +
    (on ? 'border-pink-400 bg-pink-600/80 text-white' : 'border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700');
  return (
    <div
      dir="rtl"
      data-testid="compare-versions"
      className="flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-slate-600/70 bg-slate-900/90 p-1 shadow-lg backdrop-blur [scrollbar-width:none]"
    >
      {item('old', oldName)}
      {item('new', newName)}
      <button type="button" aria-pressed={colors} onClick={() => useCompare.setState({ colors: !colors })} className={tog(colors)} data-testid="compare-colors" title={colors ? 'הצג בשחור (ללא צבעים)' : 'הצג כל גרסה בצבע שלה'}>
        <IconDrop />
        {!compact && 'צבעים'}
      </button>
      <button
        type="button"
        aria-pressed={curtain}
        onClick={() => useCompare.setState({ curtain: !curtain, curtainX: 0.5, layers: { old: true, new: true } })}
        className={tog(curtain)}
        data-testid="compare-curtain-toggle"
        title="וילון: גרסה קודמת מצד אחד, חדשה מהצד השני — גרור את הקו"
      >
        <IconCurtain />
        וילון
      </button>
      {sharpening && (
        <span className="flex shrink-0 items-center gap-1 px-1.5 text-[11px] text-slate-400" data-testid="compare-sharpening" title="הגרסה השנייה מתחדדת לזום הנוכחי">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-500 border-t-slate-200" aria-hidden="true" />
          {!compact && 'מחדד…'}
        </span>
      )}
    </div>
  );
}

function IconDrop() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.7S5 10 5 14.5a7 7 0 0 0 14 0C19 10 12 2.7 12 2.7z" />
    </svg>
  );
}

function IconCurtain() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
      <path d="M8 12h-2M18 12h-2" />
    </svg>
  );
}

function IconSliders() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  );
}

/**
 * Details under the bar (as in Forma's compare window): display mode
 * (glowing markers / colour overlay of both versions), overlay layers,
 * change types with counts (click = show / hide) and the list of changes
 * (click = zoom to it).
 */
function CompareDetails({ totals, done }: { totals: CompareTotals; done: boolean }) {
  const mode = useCompare((s) => s.mode);
  const regionsOn = useCompare((s) => s.regionsOn);
  const filter = useCompare((s) => s.filter);
  const regions = useCompare((s) => s.regions);
  const notes = useCompare((s) => s.notes);
  const selected = useCompare((s) => s.selected);
  const oldId = useCompare((s) => s.oldId);
  const newId = useCompare((s) => s.newId);
  const docs = useViewer((s) => s.docs);
  const currentPage = useViewer((s) => s.currentPage);

  // Changes of the new version + pages that exist only in the old one, in page order.
  const items: { docId: string; local: number; global: number; index: number; r: DiffRegion; kind: ChangeKind; old: boolean }[] = [];
  for (const id of [newId, oldId]) {
    const d = docs.find((x) => x.id === id);
    if (!d) continue;
    for (const k of Object.keys(regions[d.id] ?? {})) {
      const local = Number(k);
      const note = notes[d.id]?.[local];
      if (id === oldId && note !== 'removed') continue;
      shownRegions({ regions, notes, filter }, d.id, local).forEach((r, index) =>
        items.push({ docId: d.id, local, global: d.pageOffset + local, index, r, kind: regionKind(r, note), old: id === oldId }),
      );
    }
  }
  items.sort((a, b) => (a.old !== b.old ? (a.old ? 1 : -1) : a.local - b.local || a.index - b.index));

  const pick = (it: (typeof items)[number]) => {
    const size = useViewer.getState().pageSizes[it.global - 1];
    useCompare.setState({ selected: { docId: it.docId, local: it.local, index: it.index }, visible: true });
    if (!size) return;
    const padX = Math.max(it.r.width * size.width * 0.6, 40);
    const padY = Math.max(it.r.height * size.height * 0.6, 40);
    focusRect(it.global, {
      x: it.r.x * size.width - padX,
      y: it.r.y * size.height - padY,
      width: it.r.width * size.width + 2 * padX,
      height: it.r.height * size.height + 2 * padY,
    });
  };

  const seg = (on: boolean) =>
    'h-8 flex-1 rounded-md px-2 text-xs font-semibold transition-colors ' + (on ? 'bg-pink-600 text-white shadow' : 'text-slate-300 hover:bg-slate-700');
  const chip = (on: boolean) =>
    'flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors ' +
    (on ? 'border-slate-500 bg-slate-800 text-white' : 'border-slate-700 bg-transparent text-slate-500 line-through');

  return (
    <div
      data-testid="compare-panel"
      className="w-[min(22rem,calc(100vw-1rem))] rounded-xl border border-pink-500/50 bg-slate-900/95 p-2.5 text-slate-100 shadow-[0_0_18px_rgba(255,42,149,0.35)] backdrop-blur"
    >
      <div className="mb-2 text-center text-xs font-semibold text-pink-200" data-testid="compare-panel-total">
        {done ? `סה״כ ${totals.changes} שינויים ב-${totals.pages} דפים` : 'ההשוואה עדיין רצה…'}
      </div>
      <div className="flex gap-1 rounded-lg bg-slate-800 p-0.5" role="radiogroup" aria-label="אופן הצגה">
        <button type="button" role="radio" aria-checked={mode === 'layers'} className={seg(mode === 'layers')} onClick={() => useCompare.setState({ mode: 'layers', visible: true })} data-testid="compare-mode-layers">
          שכבות צבע
        </button>
        <button type="button" role="radio" aria-checked={mode === 'marker'} className={seg(mode === 'marker')} onClick={() => useCompare.setState({ mode: 'marker', curtain: false })} data-testid="compare-mode-marker">
          סימון זוהר
        </button>
      </div>
      {mode === 'layers' && (
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={regionsOn} onChange={(e) => useCompare.setState({ regionsOn: e.target.checked })} className="accent-pink-500" data-testid="compare-regions-on" />
          סמן גם את אזורי השינוי במסגרת
        </label>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="סוגי שינויים">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={filter[k]}
            onClick={() => useCompare.setState({ filter: { ...filter, [k]: !filter[k] }, selected: null })}
            className={chip(filter[k])}
            data-testid={`compare-filter-${k}`}
            title={filter[k] ? `הסתר "${KIND_LABEL[k]}"` : `הצג "${KIND_LABEL[k]}"`}
          >
            <span className={'h-2.5 w-2.5 rounded-full ' + KIND_DOT[k]} />
            {KIND_LABEL[k]}
            <span className="tabular-nums text-slate-400">{totals.byKind[k]}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 max-h-[min(40vh,18rem)] overflow-y-auto rounded-lg border border-slate-700/70" data-testid="compare-list">
        {items.length === 0 ? (
          <div className="p-3 text-center text-xs text-slate-500">אין שינויים להצגה</div>
        ) : (
          items.map((it) => {
            const sel = selected?.docId === it.docId && selected.local === it.local && selected.index === it.index;
            return (
              <button
                key={`${it.docId}:${it.local}:${it.index}`}
                type="button"
                onClick={() => pick(it)}
                data-testid="compare-list-item"
                className={
                  'flex w-full items-center gap-2 border-b border-slate-800 px-2.5 py-1.5 text-start text-xs last:border-b-0 hover:bg-slate-800 ' +
                  (sel ? 'bg-pink-950/60' : it.global === currentPage ? 'bg-slate-800/50' : '')
                }
              >
                <span className={'h-2.5 w-2.5 shrink-0 rounded-full ' + KIND_DOT[it.kind]} />
                <span className="font-semibold">{KIND_LABEL[it.kind]}</span>
                <span className="text-slate-400">
                  {it.old ? 'גרסה קודמת · ' : ''}דף {it.local}
                </span>
                <span className="ms-auto rounded-full bg-slate-700 px-1.5 tabular-nums text-slate-300">#{it.index + 1}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
