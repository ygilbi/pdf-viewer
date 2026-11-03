import { create } from 'zustand';
import type { AreaMeasurement, Calibration, Category, PageSize, Point, ToolId, WorkspaceDoc } from '../core/types';
import { concatPages, layoutDocs, removeDocFromWorkspace } from './workspace';
import { DEFAULT_CATEGORIES, MEASUREMENT_COLORS, kindOf } from '../core/measurementEngine';
import { coalesce, withHistory, type HistoryState } from './history';

/**
 * Global UI state. Keep high-frequency state (pan/zoom transform, mouse
 * position) OUT of this store — ViewerCanvas holds it in refs so that panning
 * never triggers React re-renders.
 */
export interface ViewerState extends HistoryState {
  // document(s)
  /** Name of the first open file (null = nothing open). */
  fileName: string | null;
  /**
   * Open files in workspace order. Their pages form one continuous list of
   * GLOBAL page numbers; numPages / pageSizes below are the concatenation.
   */
  docs: WorkspaceDoc[];
  numPages: number;
  pageSizes: PageSize[];
  currentPage: number; // 1-based
  loading: boolean;
  error: string | null;

  // tools
  tool: ToolId;
  /** Points being placed by the active tool (calibrate: up to 2, area: n). */
  draft: Point[];

  // measurements (keyed by page number)
  calibrations: Record<number, Calibration>;
  measurements: AreaMeasurement[];
  selectedId: string | null;

  // categories (persisted with the document)
  categories: Category[];
  /** Category id given to new measurements (null = none). Not persisted. */
  activeCategoryId: string | null;

  // actions
  /** Single-file open: resets the workspace to this one document (and clears measurements). */
  setDocument(info: { fileName: string; numPages: number; pageSizes: PageSize[]; docId?: string; fingerprint?: string }): void;
  /** Appends a file to the workspace (pageOffset is recomputed from order). */
  addDocument(doc: WorkspaceDoc): void;
  /** Patches a doc (e.g. its fingerprint once hashing finished). */
  updateDocument(docId: string, patch: Partial<Pick<WorkspaceDoc, 'fingerprint' | 'name'>>): void;
  /**
   * Removes a file with its measurements/calibrations; later files' pages are
   * renumbered and currentPage adjusted. Removing the last file empties the workspace.
   */
  removeDocument(docId: string): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  setPage(page: number): void;
  setTool(tool: ToolId): void;
  setDraft(points: Point[]): void;
  setCalibration(page: number, c: Calibration): void;
  addMeasurement(m: AreaMeasurement): void;
  updateMeasurement(id: string, patch: Partial<Omit<AreaMeasurement, 'id'>>): void;
  removeMeasurement(id: string): void;
  select(id: string | null): void;
  setActiveCategory(id: string | null): void;
  /** Adds a category (color auto-picked when omitted) and returns its id. */
  addCategory(name: string, color?: string): string;
  /** Sets (or clears) a measurement's category; non-deduct measurements adopt the category color. */
  setMeasurementCategory(id: string, categoryId: string | null): void;
}

export const useViewer = create<ViewerState>()(
  withHistory<ViewerState>((set, get) => ({
  fileName: null,
  docs: [],
  numPages: 0,
  pageSizes: [],
  currentPage: 1,
  loading: false,
  error: null,
  tool: 'pan',
  draft: [],
  calibrations: {},
  measurements: [],
  selectedId: null,
  categories: DEFAULT_CATEGORIES,
  activeCategoryId: null,

  setDocument: ({ fileName, numPages, pageSizes, docId, fingerprint }) => {
    set({
      fileName,
      docs: [{ id: docId ?? 'doc', name: fileName, fingerprint, numPages, pageOffset: 0, pageSizes }],
      numPages,
      pageSizes,
      currentPage: 1,
      error: null,
      draft: [],
      calibrations: {},
      measurements: [],
      selectedId: null,
      categories: DEFAULT_CATEGORIES,
      activeCategoryId: null,
    });
    get().resetHistory();
  },
  addDocument: (doc) =>
    set((s) => {
      const docs = layoutDocs([...s.docs.filter((d) => d.id !== doc.id), { ...doc }]);
      return { docs, ...concatPages(docs), fileName: docs[0].name, error: null };
    }),
  updateDocument: (docId, patch) =>
    set((s) => ({
      docs: s.docs.map((d) => (d.id === docId ? { ...d, ...patch } : d)),
      fileName: s.docs[0]?.id === docId && patch.name ? patch.name : s.fileName,
    })),
  removeDocument: (docId) => {
    set((s) => {
      const r = removeDocFromWorkspace(s, docId);
      if (!r) return {};
      const selectedGone = s.selectedId != null && !r.measurements.some((m) => m.id === s.selectedId);
      return {
        ...r,
        fileName: r.docs[0]?.name ?? null,
        draft: [],
        selectedId: selectedGone ? null : s.selectedId,
        ...(r.docs.length === 0 ? { categories: DEFAULT_CATEGORIES, activeCategoryId: null } : {}),
      };
    });
    // Page numbers were renumbered: older snapshots no longer line up.
    get().resetHistory();
  },
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setPage: (page) => {
    const { numPages } = get();
    if (numPages === 0) return;
    const p = Math.min(Math.max(1, Math.round(page)), numPages);
    set({ currentPage: p, draft: [], selectedId: null });
  },
  setTool: (tool) => set({ tool, draft: [] }),
  setDraft: (draft) => set({ draft }),
  setCalibration: (page, c) => set((s) => ({ calibrations: { ...s.calibrations, [page]: c } })),
  addMeasurement: (m) => set((s) => ({ measurements: [...s.measurements, m], selectedId: m.id })),
  updateMeasurement: (id, patch) => {
    // Text / label / style edits in a row on one item = one undo step; geometry edits never merge.
    const keys = Object.keys(patch).sort();
    coalesce(keys.includes('points') ? null : `update:${id}:${keys.join(',')}`);
    set((s) => ({ measurements: s.measurements.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  },
  removeMeasurement: (id) =>
    set((s) => ({
      measurements: s.measurements.filter((m) => m.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),
  select: (selectedId) => set({ selectedId }),
  setActiveCategory: (id) =>
    set((s) => ({ activeCategoryId: id && s.categories.some((c) => c.id === id) ? id : null })),
  addCategory: (name, color) => {
    const s = get();
    const n = s.categories.length;
    const id = `cat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const c: Category = { id, name, color: color ?? MEASUREMENT_COLORS[n % MEASUREMENT_COLORS.length] };
    set({ categories: [...s.categories, c] });
    return id;
  },
  setMeasurementCategory: (id, categoryId) =>
    set((s) => {
      const cat = categoryId ? s.categories.find((c) => c.id === categoryId) : undefined;
      return {
        measurements: s.measurements.map((m) => {
          if (m.id !== id) return m;
          const next: AreaMeasurement = { ...m, category: cat?.id };
          if (!cat) delete next.category;
          if (cat && kindOf(m) !== 'deduct') next.color = cat.color;
          return next;
        }),
      };
    }),
}),
  ),
);
