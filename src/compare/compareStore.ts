/**
 * Version compare state: which two open files are compared, progress, the
 * changed regions per file page (normalized 0..1 rects, shown on BOTH files so
 * switching tabs shows what was there before / what is there now) and the
 * display options (marker / colour overlay, change-type filters, layers).
 */
import { create } from 'zustand';
import type { ChangeKind, DiffRegion } from '../core/versionDiff';

export type PageNote = 'added' | 'removed';
/**
 * 'layers' (default, as in Autodesk Forma's 2D compare): both versions drawn one over the other, each
 * in its own colour (ink in both = dark), each can be hidden, optional curtain.
 * 'marker': the page as is, with glowing boxes on the changed areas.
 */
export type CompareMode = 'layers' | 'marker';

/** Ink colours of the two versions (Forma style: one red, one blue). */
export const VERSION_COLOR = { old: '#e0262f', new: '#1f5fe0' } as const;

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
  mode: CompareMode;
  /** Change types shown. */
  filter: Record<ChangeKind, boolean>;
  /** Versions shown (layers mode): the previous / the new one. */
  layers: { old: boolean; new: boolean };
  /** Layers mode: each version in its colour (off = both black, as Forma's "hide colours"). */
  colors: boolean;
  /** Layers mode: curtain — the previous version on one side of it, the new one on the other. */
  curtain: boolean;
  /** Curtain position: fraction of the page width (0..1). */
  curtainX: number;
  /** Layers mode: the sharp layer of the other version is being rendered for the current view. */
  sharpening: boolean;
  /** Layers mode: also frame the changed areas. */
  regionsOn: boolean;
  /** New local page → alignment of the old page (fractions of the page: old(x+dx) ≈ new(x)). */
  shifts: Record<number, { dx: number; dy: number }>;
  /** Details panel (types, layers, list of changes) open under the bar. */
  panelOpen: boolean;
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
  shifts: {},
  selected: null,
  error: null,
};

export const useCompare = create<CompareState>(() => ({
  ...initialCompare,
  dialogOpen: false,
  runId: 0,
  mode: 'layers',
  filter: { added: true, removed: true, modified: true },
  layers: { old: true, new: true },
  colors: true,
  curtain: false,
  curtainX: 0.5,
  regionsOn: false,
  sharpening: false,
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
