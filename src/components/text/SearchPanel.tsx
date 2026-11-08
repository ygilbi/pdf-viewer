import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useViewer } from '../../state/store';
import { MAX_RESULTS, countMatchesAsItems, useSearch } from '../../text/searchStore';
import { usePageTextInfo } from '../../text/pageTextInfo';
import { docsWithoutText, groupResultsByDoc, type SearchScope } from '../../text/searchScope';
import type { TextMatch } from '../../text/textSearch';
import { IconFilePdf, IconX } from '../ui/icons';
import { isTypingTarget } from '../ui/util';

export const IconSearch = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

/** The search box in the file tab bar (Ctrl+F focuses it). */
export const TABBAR_SEARCH_SELECTOR = '[data-testid="tabbar-search"]';

/** Focuses the tab bar's "search in files" box; falls back to the panel. */
export function focusTabbarSearch(): void {
  const el = document.querySelector<HTMLInputElement>(TABBAR_SEARCH_SELECTOR);
  if (!el || el.offsetParent === null) return openSearch();
  el.focus();
  el.select();
}

/** Opens the search panel and focuses its input (F3 / Ctrl+F / menu). */
export function openSearch(): void {
  useSearch.getState().setOpen(true);
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
    el?.focus();
    el?.select();
  });
}

/** F3 / Ctrl+F open (F3 again = next, Shift+F3 = previous). Capture phase: beats the browser's find bar. */
function useSearchKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useViewer.getState().numPages === 0) return;
      const isF3 = e.key === 'F3';
      const isCtrlF = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyF';
      if (!isF3 && !isCtrlF) return;
      if (
        isCtrlF &&
        isTypingTarget(e.target) &&
        !(e.target as HTMLElement).closest('[data-testid="search-panel"]') &&
        !(e.target as HTMLElement).matches(TABBAR_SEARCH_SELECTOR)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      const s = useSearch.getState();
      if (isF3 && s.open && s.results.length) {
        const n = s.results.length;
        s.goTo(((s.activeIndex < 0 ? (e.shiftKey ? 0 : -1) : s.activeIndex) + (e.shiftKey ? -1 : 1) + n) % n);
        return;
      }
      if (isCtrlF) focusTabbarSearch();
      else openSearch();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function Toggle({ on, onClick, title, children, testId }: { on: boolean; onClick(): void; title: string; children: ReactNode; testId: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      data-testid={testId}
      className={
        'h-7 rounded border px-1.5 font-mono text-[11px] transition-colors ' +
        (on ? 'border-sky-500 bg-sky-600/30 text-sky-200' : 'border-slate-600 text-slate-400 hover:bg-slate-700 hover:text-white')
      }
    >
      {children}
    </button>
  );
}

function Highlighted({ m }: { m: TextMatch }) {
  const ctx = m.context;
  const a = Math.max(0, m.start - 30);
  const b = Math.min(ctx.length, m.end + 30);
  return (
    <span dir="auto" className="min-w-0 flex-1 truncate">
      {a > 0 && '…'}
      {ctx.slice(a, m.start)}
      <mark className="rounded-sm bg-yellow-400/80 px-0.5 text-slate-900">{ctx.slice(m.start, m.end)}</mark>
      {ctx.slice(m.end, b)}
      {b < ctx.length && '…'}
      {m.after && <span className="text-slate-500"> {m.after}</span>}
    </span>
  );
}

/** Floating panel "חיפוש וספירה" (left side, over the drawing). Always mounted for its shortcuts. */
export function SearchPanel() {
  useSearchKeys();
  const open = useSearch((s) => s.open);
  // A changed workspace (file added/removed/reordered) invalidates page numbers of results.
  const layoutKey = useViewer((s) => s.docs.map((d) => `${d.id}:${d.pageOffset}:${d.numPages}`).join('|'));
  useEffect(() => {
    useSearch.getState().clear();
  }, [layoutKey]);

  if (!open) return null;
  return <SearchPanelBody />;
}

function SearchPanelBody() {
  const s = useSearch();
  const currentPage = useViewer((v) => v.currentPage);
  const numPages = useViewer((v) => v.numPages);
  const docs = useViewer((v) => v.docs);
  const multi = docs.length > 1;
  const curDoc = docs.find((d) => currentPage > d.pageOffset && currentPage <= d.pageOffset + d.numPages);
  const activeCat = useViewer((v) => v.categories.find((c) => c.id === v.activeCategoryId));
  const info = usePageTextInfo(currentPage);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const pagesWithHits = useMemo(() => new Set(s.results.map((r) => r.page)).size, [s.results]);
  const grouped = useMemo(() => groupResultsByDoc(s.results, docs), [s.results, docs]);
  const noText = useMemo(
    () => (s.running || s.scope === 'page' ? [] : docsWithoutText(docs, s.scanned, s.pagesWithText)),
    [docs, s.scanned, s.pagesWithText, s.running, s.scope],
  );
  const scopes: { id: SearchScope; label: string; title: string }[] = multi
    ? [
        { id: 'page', label: 'דף נוכחי', title: `דף ${currentPage}` },
        { id: 'doc', label: 'קובץ נוכחי', title: curDoc ? `${curDoc.name} (${curDoc.numPages} דפים)` : '' },
        { id: 'all', label: `כל הקבצים (${docs.length})`, title: `${docs.length} קבצים, ${numPages} דפים` },
      ]
    : [
        { id: 'page', label: 'דף נוכחי', title: `דף ${currentPage}` },
        { id: 'all', label: `כל הדפים (${numPages})`, title: `${numPages} דפים` },
      ];
  // Single file: "current file" is the same as all pages.
  const shownScope: SearchScope = !multi && s.scope === 'doc' ? 'all' : s.scope;

  // Keep the active result in view.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [s.activeIndex]);

  const stale = s.ranQuery !== null && s.ranQuery !== s.query;
  const canCount = !s.running && !stale && s.results.length > 0 && s.ranQuery;

  const countAll = () => {
    if (!s.ranQuery) return;
    const label = s.ranQuery.trim();
    const { markers, groups } = countMatchesAsItems(label, s.results);
    setNotice(`נוצרו ${markers} סימוני ספירה „${label}” ב‑${groups} ${groups === 1 ? 'דף' : 'דפים'}`);
  };

  const countTag = async (tag: string) => {
    const st = useSearch.getState();
    st.setOptions({ wholeWord: true, caseSensitive: true, regex: false });
    st.setScope('page');
    await st.run(tag);
    const after = useSearch.getState();
    if (after.ranQuery === tag && after.results.length) {
      const { markers } = countMatchesAsItems(tag, after.results);
      setNotice(`נוצרו ${markers} סימוני ספירה „${tag}” בדף ${currentPage}`);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="חיפוש וספירה"
      data-testid="search-panel"
      dir="rtl"
      className="absolute left-2 top-14 z-[35] flex max-h-[calc(100%-4.5rem)] w-80 max-w-[calc(100vw-1rem)] flex-col rounded-lg border border-slate-600/80 bg-slate-900/95 text-sm text-slate-200 shadow-2xl shadow-black/60 backdrop-blur"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          s.setOpen(false);
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-slate-700 px-3 py-2">
        <IconSearch size={14} />
        <span className="flex-1 text-xs font-medium">חיפוש וספירה</span>
        <span className="text-[10px] text-slate-500">F3 / Ctrl+F</span>
        <button type="button" onClick={() => s.setOpen(false)} aria-label="סגור חיפוש" className="rounded p-0.5 text-slate-400 hover:bg-slate-700 hover:text-white">
          <IconX size={14} />
        </button>
      </div>

      <div className="space-y-2 px-3 py-2">
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setNotice(null);
            void s.run();
          }}
        >
          <input
            data-testid="search-input"
            type="search"
            dir="auto"
            value={s.query}
            onChange={(e) => s.setQuery(e.target.value)}
            placeholder="למשל W1, D2, CW-1, חלון…"
            className="h-8 min-w-0 flex-1 rounded border border-slate-600 bg-slate-950 px-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') s.setOpen(false);
            }}
          />
          <button type="submit" data-testid="search-go" className="h-8 rounded bg-sky-600 px-3 text-xs text-white hover:bg-sky-500">
            חפש
          </button>
        </form>
        <div className="flex flex-wrap items-center gap-1">
          <Toggle testId="opt-word" on={s.options.wholeWord} onClick={() => s.setOptions({ wholeWord: !s.options.wholeWord })} title="מילה שלמה (W1 לא ימצא W10)">
            ab|
          </Toggle>
          <Toggle testId="opt-case" on={s.options.caseSensitive} onClick={() => s.setOptions({ caseSensitive: !s.options.caseSensitive })} title="הבחנה בין אותיות גדולות/קטנות">
            Aa
          </Toggle>
          <Toggle testId="opt-regex" on={s.options.regex} onClick={() => s.setOptions({ regex: !s.options.regex })} title="ביטוי רגולרי">
            .*
          </Toggle>
          <span className="flex-1" />
          <div className="flex overflow-hidden rounded border border-slate-600 text-[11px]" role="radiogroup" aria-label="היקף החיפוש">
            {scopes.map((sc) => (
              <button
                key={sc.id}
                type="button"
                role="radio"
                aria-checked={shownScope === sc.id}
                data-testid={`scope-${sc.id}`}
                title={sc.title}
                onClick={() => s.setScope(sc.id)}
                className={'h-7 whitespace-nowrap px-1.5 ' + (shownScope === sc.id ? 'bg-slate-600 text-white' : 'text-slate-400 hover:bg-slate-700')}
              >
                {sc.label}
              </button>
            ))}
          </div>
        </div>

        {s.error && <div className="text-xs text-red-300">{s.error}</div>}
        {s.ranQuery !== null && !s.error && (
          <div className="flex items-center gap-2 text-xs text-slate-400" data-testid="search-status" aria-live="polite">
            <span>
              {s.results.length}
              {s.truncated ? '+' : ''} תוצאות{pagesWithHits > 1 ? ` ב‑${pagesWithHits} דפים` : ''}
              {multi && grouped.length > 1 ? ` · ${grouped.length} קבצים` : ''}
            </span>
            {s.running && (
              <>
                <span className="text-sky-300" data-testid="search-progress">
                  סורק {s.done}/{s.total}…
                </span>
                <button type="button" className="text-slate-400 underline hover:text-white" onClick={() => s.cancel()}>
                  עצור
                </button>
              </>
            )}
            {s.truncated && <span className="text-amber-300">(מוצגות {MAX_RESULTS} הראשונות)</span>}
          </div>
        )}
        {s.ranQuery !== null && !s.running && s.results.length === 0 && !s.error && s.scope === 'page' && info.status === 'ready' && info.runs === 0 && (
          <div className="text-xs text-amber-300">אין בדף טקסט שניתן לחפש (שרטוט סרוק או טקסט כקווים).</div>
        )}
        {noText.length > 0 && (
          <div className="space-y-0.5 text-[11px] text-amber-300" data-testid="search-no-text">
            {noText.map((d) => (
              <div key={d.id} className="flex gap-1">
                <span className="min-w-0 truncate" dir="auto" title={d.name}>
                  {multi ? d.name : 'בקובץ'}
                </span>
                <span className="shrink-0">— אין שכבת טקסט (סרוק?), לא ניתן לחפש בו.</span>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          disabled={!canCount}
          onClick={countAll}
          data-testid="count-all"
          title={activeCat ? `ייווצרו קבוצות ספירה בקטגוריה „${activeCat.name}”` : 'ייווצרו קבוצות ספירה (קבוצה אחת לכל דף)'}
          className="flex h-8 w-full items-center justify-center gap-1 rounded border border-emerald-600/70 bg-emerald-900/30 text-xs text-emerald-200 hover:bg-emerald-800/50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ספור הכל כפריט{canCount ? ` (${s.results.length})` : ''}
          {activeCat && <span className="text-emerald-400/80">· {activeCat.name}</span>}
        </button>
        {notice && (
          <div className="rounded bg-emerald-950/60 px-2 py-1 text-[11px] text-emerald-300" data-testid="count-notice">
            {notice} — כולל הופעות במקרא/טבלאות; הסר סימונים מיותרים בכלי הספירה.
          </div>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto border-t border-slate-700" data-testid="search-results">
        {grouped.map((dg) => (
          <div key={dg.doc?.id ?? '?'} data-testid="search-doc-group">
            {multi && dg.doc && (
              <div className="flex items-center gap-1.5 border-b border-slate-700/70 bg-slate-950/60 px-3 py-1 text-[11px] font-medium text-slate-200">
                <IconFilePdf size={12} className="shrink-0 text-red-400" />
                <span className="min-w-0 flex-1 truncate" dir="auto" title={dg.doc.name}>
                  {dg.doc.name}
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">{dg.count}</span>
              </div>
            )}
            {dg.pages.map((g) => (
              <div key={g.page}>
                <div className="sticky top-0 flex gap-1 bg-slate-800/95 px-3 py-0.5 text-[11px] text-slate-400" data-testid="search-page-header">
                  {multi && dg.doc ? (
                    <>
                      <span className="min-w-0 truncate" dir="auto">
                        {dg.doc.name.replace(/\.pdf$/i, '')}
                      </span>
                      <span className="shrink-0">
                        › עמוד {g.localPage} · {g.items.length}
                      </span>
                    </>
                  ) : (
                    <span>
                      דף {g.page} · {g.items.length}
                    </span>
                  )}
                </div>
                {g.items.slice(0, 300).map(({ m, i }) => (
                  <button
                    key={i}
                    type="button"
                    data-active={i === s.activeIndex ? 'true' : 'false'}
                    data-testid="search-result"
                    onClick={() => s.goTo(i)}
                    className={
                      'flex w-full items-center gap-2 px-3 py-1 text-start text-xs hover:bg-slate-700/70 ' +
                      (i === s.activeIndex ? 'bg-sky-900/50 text-white' : 'text-slate-300')
                    }
                  >
                    <Highlighted m={m} />
                  </button>
                ))}
                {g.items.length > 300 && <div className="px-3 py-1 text-[11px] text-slate-500">ועוד {g.items.length - 300} בדף זה…</div>}
              </div>
            ))}
          </div>
        ))}

        {info.status === 'ready' && info.tags.length > 0 && (
          <div className="border-t border-slate-700 px-3 py-2" data-testid="common-tags">
            <div className="mb-1 text-[11px] text-slate-400">תגיות שכיחות בדף {currentPage}</div>
            <div className="space-y-0.5">
              {info.tags.slice(0, 40).map((t) => (
                <div key={t.tag} className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    className="flex-1 truncate text-start font-mono text-slate-200 hover:text-sky-300"
                    title="חפש"
                    onClick={() => {
                      s.setOptions({ wholeWord: true, caseSensitive: true, regex: false });
                      s.setScope('page');
                      void s.run(t.tag);
                    }}
                    dir="ltr"
                  >
                    {t.tag}
                  </button>
                  <span className="tabular-nums text-slate-500">×{t.count}</span>
                  <button
                    type="button"
                    data-testid="tag-count"
                    data-tag={t.tag}
                    onClick={() => void countTag(t.tag)}
                    className="rounded border border-slate-600 px-1.5 text-[11px] text-emerald-300 hover:bg-slate-700"
                  >
                    ספור
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
