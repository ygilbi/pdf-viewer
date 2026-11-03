/**
 * Undo / redo for document data (measurements, markup, calibrations, categories).
 *
 * Implemented as a zustand middleware around the store's `set`: every action
 * that changes one of the TRACKED slices pushes the previous slices onto
 * `historyPast` (references only — immutable updates give structural sharing
 * for free, so a snapshot costs three pointers). Depth HISTORY_LIMIT.
 *
 * - Coalescing: an action may tag its change with `coalesce(key)`; consecutive
 *   changes with the same key within COALESCE_MS form one step (e.g. typing a
 *   note's text, renaming a label). `historyGroup(fn)` makes everything inside
 *   one step (e.g. a multi-part edit).
 * - `useViewer.setState(...)` from outside the actions (persistence restore)
 *   is NOT undoable: if it changes tracked data the history is cleared, so an
 *   undo can never resurrect a stale snapshot over restored data.
 * - `resetHistory()` on document open / file removal.
 */
import type { StateCreator, StoreApi } from 'zustand';
import type { AreaMeasurement, Calibration, Category } from '../core/types';

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 1000;

export interface HistorySnapshot {
  measurements: AreaMeasurement[];
  calibrations: Record<number, Calibration>;
  categories: Category[];
}

export interface HistoryState {
  historyPast: HistorySnapshot[];
  historyFuture: HistorySnapshot[];
  undo(): void;
  redo(): void;
  resetHistory(): void;
}

type Tracked = HistorySnapshot & HistoryState & { selectedId?: string | null; draft?: unknown[] };

const snap = (s: HistorySnapshot): HistorySnapshot => ({
  measurements: s.measurements,
  calibrations: s.calibrations,
  categories: s.categories,
});
const differs = (a: HistorySnapshot, b: HistorySnapshot) =>
  a.measurements !== b.measurements || a.calibrations !== b.calibrations || a.categories !== b.categories;

// Module-level (one viewer store per app; tests reset via resetHistory()).
let nextKey: string | null = null;
let last: { key: string; t: number } | null = null;
let groupDepth = 0;
let groupRecorded = false;
let now: () => number = () => Date.now();

/** Tag the NEXT tracked change: same key within COALESCE_MS of the previous one → same undo step. */
export function coalesce(key: string | null) {
  nextKey = key;
}

/** Run `fn`; all tracked changes inside form a single undo step. */
export function historyGroup<T>(fn: () => T): T {
  groupDepth++;
  if (groupDepth === 1) groupRecorded = false;
  try {
    return fn();
  } finally {
    groupDepth--;
  }
}

/** Test hook: inject a clock. */
export function _setHistoryClock(fn: () => number) {
  now = fn;
}

/** Middleware: wraps the creator's `set` (NOT api.setState — see header). */
export function withHistory<T extends Tracked>(
  config: StateCreator<T, [], [], Omit<T, keyof HistoryState>>,
): StateCreator<T, [], []> {
  return (set, get, api: StoreApi<T>) => {
    let internal = false;

    const record = (before: HistorySnapshot) => {
      const key = nextKey;
      nextKey = null;
      const t = now();
      if (groupDepth > 0) {
        if (groupRecorded) return;
        groupRecorded = true;
      } else if (key && last && last.key === key && t - last.t < COALESCE_MS) {
        last.t = t;
        // Same gesture continues: keep the snapshot from its start, but a redo branch is gone.
        if (get().historyFuture.length) rawSet({ historyFuture: [] } as unknown as Partial<T>);
        return;
      }
      last = key ? { key, t } : null;
      const past = get().historyPast;
      const next = past.length >= HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT + 1) : past.slice();
      next.push(before);
      rawSet({ historyPast: next, historyFuture: [] } as unknown as Partial<T>);
    };

    const rawSet = (p: Partial<T>) => {
      internal = true;
      try {
        set(p);
      } finally {
        internal = false;
      }
    };

    const trackedSet: typeof set = (partial, replace?: boolean) => {
      if (internal) {
        (set as (p: unknown, r?: boolean) => void)(partial, replace);
        return;
      }
      const before = snap(get());
      (set as (p: unknown, r?: boolean) => void)(partial, replace);
      if (differs(before, get())) record(before);
      else nextKey = null;
    };

    // External setState: not undoable; clears history when it touches tracked data.
    const origSetState = api.setState;
    api.setState = ((partial: unknown, replace?: boolean) => {
      const before = snap(get());
      (origSetState as (p: unknown, r?: boolean) => void)(partial, replace);
      if (!internal && differs(before, get()) && (get().historyPast.length || get().historyFuture.length)) {
        last = null;
        (origSetState as (p: unknown) => void)({ historyPast: [], historyFuture: [] });
      }
    }) as typeof api.setState;

    const state = config(trackedSet, get, api);

    const restore = (from: 'historyPast' | 'historyFuture') => {
      const s = get();
      const stack = s[from];
      if (!stack.length) return;
      const target = stack[stack.length - 1];
      const cur = snap(s);
      const rest = stack.slice(0, -1);
      const other = from === 'historyPast' ? s.historyFuture : s.historyPast;
      const otherNext = [...other, cur].slice(-HISTORY_LIMIT);
      last = null;
      const sel = s.selectedId && target.measurements.some((m) => m.id === s.selectedId) ? s.selectedId : null;
      rawSet({
        ...target,
        [from]: rest,
        [from === 'historyPast' ? 'historyFuture' : 'historyPast']: otherNext,
        selectedId: sel,
        draft: [],
      } as unknown as Partial<T>);
    };

    return {
      ...(state as T),
      historyPast: [],
      historyFuture: [],
      undo: () => restore('historyPast'),
      redo: () => restore('historyFuture'),
      resetHistory: () => {
        last = null;
        nextKey = null;
        rawSet({ historyPast: [], historyFuture: [] } as unknown as Partial<T>);
      },
    };
  };
}
