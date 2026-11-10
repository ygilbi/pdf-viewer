/**
 * Version compare state: which two open files are compared, progress, the
 * changed regions per file page (normalized 0..1 rects, shown on BOTH files so
 * switching tabs shows what was there before / what is there now) and the
 * display options (marker / colour overlay, change-type filters, layers).
 */
import { create } from 'zustand';
import type { ChangeKind, DiffRegion } from '../core/versionDiff';

export type PageNote = 'added' | 'removed';
export type CompareMode = 'marker' | 'overlay';

export interface OverlayImage {
  /** New-version page (local) the image belongs to. */
  newLocal: number;
  w: number;
  h: number;
  /** Per pixel: 0 paper, 1 both, 2 added, 3 removed (see versionDiff.PageDiff.overlay). */
  classes: Uint8Array;
}

export interface CompareState {
  /** Dialog to pick the two versions. */
  dialogOpen: boolean;
  status: 'idle' | 'running' | 'done' | 'error';
  /** What the progress counts right now. */
  phase: 'match' | 'diff';
  oldId: string | null;
  newId: string | null;
  /** Pages compared so far / to compare. */
  progress: { done: number; total: number };
  /** docId → local page → changed regions. */
  regions: Record<string, Record<number, DiffRegion[]>>;
  /** docId → local page → page exists in this version only. */
  notes: Record<string, Record<number, PageNote>>;
  /** docId → local page → the matching local page in the other version. */
  pairOf: Record<string, Record<number, number>>;
  /** New pages whose pair has been diffed (for "not compared yet"). */
  diffed: Record<number, true>;
  /** Highlights shown (the bar stays). */
  visible: boolean;
  /** Glowing markers on the page, or the colour overlay of both versions (as in Forma's 2D compare). */
  mode: CompareMode;
  /** Change types shown. */
  filter: Record<ChangeKind, boolean>;
  /** Overlay layers: the previous version's / the new version's ink. */
  layers: { old: boolean; new: boolean };
  /** Details panel (types, layers, list of changes) open under the bar. */
  panelOpen: boolean;
  /** Overlay image of the page on screen (built on demand). */
  overlay: OverlayImage | null;
  overlayLoading: boolean;
  /** Change picked in the list (pulses faster). */
  selected: { docId: string; local: number; index: number } | null;
  error: string | null;
  /** Bumped on every run / reset — a stale run stops writing. */
  runId: number;
}

export const initialCompare = {
  status: 'idle' as const,
  phase: 'diff' as const,
  oldId: null,
  newId: null,
  progress: { done: 0, total: 0 },
  regions: {},
  notes: {},
  pairOf: {},
  diffed: {},
  visible: true,
  overlay: null,
  overlayLoading: false,
  selected: null,
  error: null,
};

export const useCompare = create<CompareState>(() => ({
  ...initialCompare,
  dialogOpen: false,
  runId: 0,
  mode: 'marker',
  filter: { added: true, removed: true, modified: true },
  layers: { old: true, new: true },
  panelOpen: false,
}));

export const openCompareDialog = () => useCompare.setState({ dialogOpen: true });
export const closeCompareDialog = () => useCompare.setState({ dialogOpen: false });

/** Ends the compare (highlights, bar) and stops a running one. Display preferences are kept. */
export function clearCompare(): void {
  useCompare.setState((s) => ({ ...initialCompare, panelOpen: false, runId: s.runId + 1 }));
}

/** Kind of a region (pages that exist in one version only count as added / removed). */
export const regionKind = (r: DiffRegion, note?: PageNote): ChangeKind => (note === 'added' ? 'added' : note === 'removed' ? 'removed' : (r.kind ?? 'modified'));

/** Regions of a file page that pass the type filter. */
export function shownRegions(s: Pick<CompareState, 'regions' | 'notes' | 'filter'>, docId: string, localPage: number): DiffRegion[] {
  const note = s.notes[docId]?.[localPage];
  return (s.regions[docId]?.[localPage] ?? []).filter((r) => s.filter[regionKind(r, note)]);
}

/** Number of (shown) changes on a file page (an added / removed page counts as one). */
export function changesOnPage(s: Pick<CompareState, 'regions' | 'notes' | 'filter'>, docId: string, localPage: number): number {
  return shownRegions(s, docId, localPage).length;
}

export interface CompareTotals {
  changes: number;
  pages: number;
  byKind: Record<ChangeKind, number>;
}

/** Totals over the NEW version (+ pages that exist only in the old one). byKind ignores the filter. */
export function compareTotals(s: Pick<CompareState, 'regions' | 'newId' | 'oldId' | 'notes' | 'filter'>): CompareTotals {
  const t: CompareTotals = { changes: 0, pages: 0, byKind: { added: 0, removed: 0, modified: 0 } };
  const count = (id: string | null, onlyRemoved: boolean) => {
    if (!id) return;
    for (const [k, rs] of Object.entries(s.regions[id] ?? {})) {
      const note = s.notes[id]?.[Number(k)];
      if (onlyRemoved && note !== 'removed') continue;
      let shown = 0;
      for (const r of rs) {
        const kind = regionKind(r, note);
        t.byKind[kind]++;
        if (s.filter[kind]) shown++;
      }
      if (shown) {
        t.changes += shown;
        t.pages++;
      }
    }
  };
  count(s.newId, false);
  count(s.oldId, true); // pages that exist only in the old version
  return t;
}

export const KIND_LABEL: Record<ChangeKind, string> = { added: 'נוסף', removed: 'הוסר', modified: 'שונה' };

/**
 * Changes shown on a file page, or null when the page is not part of the
 * compare or has not been compared yet.
 */
export function pageChanges(
  s: Pick<CompareState, 'status' | 'oldId' | 'newId' | 'regions' | 'notes' | 'filter' | 'pairOf' | 'diffed'>,
  docId: string,
  local: number,
): number | null {
  if (s.status === 'idle' || (docId !== s.oldId && docId !== s.newId)) return null;
  const note = s.notes[docId]?.[local];
  if (!note) {
    const newLocal = docId === s.newId ? local : s.pairOf[docId]?.[local];
    if (newLocal == null || !s.diffed[newLocal]) return null;
  }
  return changesOnPage(s, docId, local);
}
