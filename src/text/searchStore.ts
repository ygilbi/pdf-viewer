/**
 * Text search / tag-count state ("חיפוש וספירה").
 *
 * Text extraction runs in the PDF worker (cached per page); this module asks
 * for pages a few at a time and matches them on arrival, publishing results
 * incrementally — a 40-page workspace search never blocks the UI.
 */
import { create } from 'zustand';
import type { AreaMeasurement, Rect } from '../core/types';
import { getPageText } from '../core/pdfClient';
import { useViewer } from '../state/store';
import { MEASUREMENT_COLORS, newId } from '../core/measurementEngine';
import { setPendingFocus, zoomToRect } from '../components/viewer/commands';
import { DEFAULT_SEARCH_OPTIONS, buildMatcher, findInItems, type SearchOptions, type TextMatch } from './textSearch';
import { rectCenter } from './textGeometry';
import { pagesForScope, type SearchScope } from './searchScope';

export type { SearchScope } from './searchScope';

/** Max results kept (the list and highlights stay light even for "e" on 40 pages). */
export const MAX_RESULTS = 5000;
/** Pages requested from the worker at once. */
const CONCURRENCY = 3;

interface SearchState {
  open: boolean;
  query: string;
  options: SearchOptions;
  scope: SearchScope;
  /** Query/options/scope the current results belong to (null = no search yet). */
  ranQuery: string | null;
  results: TextMatch[];
  running: boolean;
  /** Pages searched / to search. */
  done: number;
  total: number;
  truncated: boolean;
  /** Global pages scanned by the current run / pages that had any text runs (for the "no text layer" note). */
  scanned: ReadonlySet<number>;
  pagesWithText: ReadonlySet<number>;
  error: string | null;
  activeIndex: number;
  setOpen(open: boolean): void;
  setQuery(q: string): void;
  setOptions(p: Partial<SearchOptions>): void;
  setScope(s: SearchScope): void;
  run(query?: string): Promise<void>;
  cancel(): void;
  clear(): void;
  goTo(index: number): void;
}

let runSeq = 0;

export const useSearch = create<SearchState>((set, get) => ({
  open: false,
  query: '',
  options: DEFAULT_SEARCH_OPTIONS,
  scope: 'page',
  ranQuery: null,
  results: [],
  running: false,
  done: 0,
  total: 0,
  truncated: false,
  scanned: new Set<number>(),
  pagesWithText: new Set<number>(),
  error: null,
  activeIndex: -1,

  setOpen: (open) => set({ open }),
  setQuery: (query) => set({ query }),
  setOptions: (p) => set((s) => ({ options: { ...s.options, ...p } })),
  setScope: (scope) => set({ scope }),
  cancel: () => {
    runSeq++;
    set({ running: false });
  },
  clear: () => {
    runSeq++;
    set({
      results: [],
      ranQuery: null,
      running: false,
      done: 0,
      total: 0,
      error: null,
      activeIndex: -1,
      truncated: false,
      scanned: new Set(),
      pagesWithText: new Set(),
    });
  },

  run: async (query) => {
    const q = query ?? get().query;
    if (query !== undefined) set({ query });
    const { options, scope } = get();
    let re: RegExp | null;
    try {
      re = buildMatcher(q, options);
    } catch (e) {
      set({ error: (e as Error).message, results: [], ranQuery: null, running: false });
      return;
    }
    if (!re) {
      get().clear();
      return;
    }
    const v = useViewer.getState();
    if (v.numPages === 0) return;
    const seq = ++runSeq;
    // Current page first, then the rest (of the current file / of all files) in order.
    const pages = pagesForScope(scope, v.docs, v.currentPage, v.numPages);
    const scanned = new Set<number>();
    const pagesWithText = new Set<number>();
    set({
      ranQuery: q,
      results: [],
      running: true,
      done: 0,
      total: pages.length,
      error: null,
      activeIndex: -1,
      truncated: false,
      scanned,
      pagesWithText,
    });

    const byPage = new Map<number, TextMatch[]>();
    let next = 0;
    let done = 0;
    let count = 0;
    let truncated = false;
    let publishScheduled = false;
    const publish = () => {
      publishScheduled = false;
      if (seq !== runSeq) return;
      const results = [...byPage.keys()].sort((a, b) => a - b).flatMap((p) => byPage.get(p)!);
      set({ results, done, truncated, scanned: new Set(scanned), pagesWithText: new Set(pagesWithText) });
    };
    const schedule = () => {
      if (publishScheduled) return;
      publishScheduled = true;
      requestAnimationFrame(publish);
    };
    const worker = async () => {
      while (next < pages.length && seq === runSeq && !truncated) {
        const page = pages[next++];
        try {
          const items = await getPageText(page).catch(() => getPageText(page)); // one retry (worker → main fallback)
          if (seq !== runSeq) return;
          scanned.add(page);
          if (items.length) pagesWithText.add(page);
          const m = findInItems(items, page, re!, MAX_RESULTS - count);
          count += m.length;
          if (count >= MAX_RESULTS) truncated = true;
          if (m.length) byPage.set(page, m);
        } catch {
          /* page without text / failed — skip */
        }
        done++;
        schedule();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker));
    if (seq !== runSeq) return;
    publish();
    set({ running: false });
  },

  goTo: (index) => {
    const r = get().results[index];
    if (!r) return;
    set({ activeIndex: index });
    focusMatch(r.page, r.rect);
  },
}));

/** Navigate to `page` (if needed) and zoom to `rect`. */
export function focusMatch(page: number, rect: Rect): void {
  const v = useViewer.getState();
  if (v.currentPage === page) zoomToRect(rect);
  else {
    setPendingFocus(page, rect);
    v.setPage(page);
  }
}

/**
 * "ספור הכל כפריט": one count group per page (label = query, active category,
 * a marker at each occurrence's centre). Returns the number of markers created.
 */
export function countMatchesAsItems(label: string, matches: readonly TextMatch[]): { markers: number; groups: number } {
  const s = useViewer.getState();
  const cat = s.activeCategoryId ? s.categories.find((c) => c.id === s.activeCategoryId) : undefined;
  const byPage = new Map<number, TextMatch[]>();
  for (const m of matches) {
    const list = byPage.get(m.page);
    if (list) list.push(m);
    else byPage.set(m.page, [m]);
  }
  let markers = 0;
  const created = new Map<number, string>();
  for (const [page, list] of [...byPage].sort((a, b) => a[0] - b[0])) {
    const color = cat?.color ?? MEASUREMENT_COLORS[useViewer.getState().measurements.length % MEASUREMENT_COLORS.length];
    const m: AreaMeasurement = {
      id: newId(),
      page,
      kind: 'count',
      label,
      points: list.map((x) => rectCenter(x.rect)),
      color,
      ...(cat ? { category: cat.id } : {}),
    };
    useViewer.getState().addMeasurement(m);
    created.set(page, m.id);
    markers += list.length;
  }
  // Select the new group on the current page (addMeasurement selected the last one added, maybe on another page).
  if (created.size) useViewer.getState().select(created.get(s.currentPage) ?? null);
  return { markers, groups: byPage.size };
}
