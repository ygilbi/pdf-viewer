/**
 * Version compare state: which two open files are compared, progress, and the
 * changed regions per file page (normalized 0..1 rects, shown on BOTH files so
 * switching tabs shows what was there before / what is there now).
 */
import { create } from 'zustand';
import type { DiffRegion } from '../core/versionDiff';

export type PageNote = 'added' | 'removed';

export interface CompareState {
  /** Dialog to pick the two versions. */
  dialogOpen: boolean;
  status: 'idle' | 'running' | 'done' | 'error';
  oldId: string | null;
  newId: string | null;
  /** Pages compared so far / to compare. */
  progress: { done: number; total: number };
  /** docId → local page → changed regions. */
  regions: Record<string, Record<number, DiffRegion[]>>;
  /** docId → local page → page exists in this version only. */
  notes: Record<string, Record<number, PageNote>>;
  /** Highlights shown (the bar stays). */
  visible: boolean;
  error: string | null;
  /** Bumped on every run / reset — a stale run stops writing. */
  runId: number;
}

export const initialCompare = {
  status: 'idle' as const,
  oldId: null,
  newId: null,
  progress: { done: 0, total: 0 },
  regions: {},
  notes: {},
  visible: true,
  error: null,
};

export const useCompare = create<CompareState>(() => ({ ...initialCompare, dialogOpen: false, runId: 0 }));

export const openCompareDialog = () => useCompare.setState({ dialogOpen: true });
export const closeCompareDialog = () => useCompare.setState({ dialogOpen: false });

/** Ends the compare (highlights, bar) and stops a running one. */
export function clearCompare(): void {
  useCompare.setState((s) => ({ ...initialCompare, runId: s.runId + 1 }));
}

/** Number of changes on a file page (an added / removed page counts as one). */
export function changesOnPage(s: Pick<CompareState, 'regions' | 'notes'>, docId: string, localPage: number): number {
  return s.regions[docId]?.[localPage]?.length ?? 0;
}

/** Total changes and pages with changes of the NEW version. */
export function compareTotals(s: Pick<CompareState, 'regions' | 'newId' | 'oldId' | 'notes'>): { changes: number; pages: number } {
  let changes = 0;
  let pages = 0;
  const count = (id: string | null, onlyRemoved: boolean) => {
    if (!id) return;
    for (const [p, r] of Object.entries(s.regions[id] ?? {})) {
      if (onlyRemoved && s.notes[id]?.[Number(p)] !== 'removed') continue;
      if (r.length) {
        changes += r.length;
        pages++;
      }
    }
  };
  count(s.newId, false);
  count(s.oldId, true); // pages that exist only in the old version
  return { changes, pages };
}
