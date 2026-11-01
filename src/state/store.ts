import { create } from 'zustand';
import type { AreaMeasurement, Calibration, Category, PageSize, Point, ToolId } from '../core/types';
import { DEFAULT_CATEGORIES, MEASUREMENT_COLORS, kindOf } from '../core/measurementEngine';

/**
 * Global UI state. Keep high-frequency state (pan/zoom transform, mouse
 * position) OUT of this store — ViewerCanvas holds it in refs so that panning
 * never triggers React re-renders.
 */
export interface ViewerState {
  // document
  fileName: string | null;
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
  setDocument(info: { fileName: string; numPages: number; pageSizes: PageSize[] }): void;
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

export const useViewer = create<ViewerState>((set, get) => ({
  fileName: null,
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

  setDocument: ({ fileName, numPages, pageSizes }) =>
    set({
      fileName,
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
    }),
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
  updateMeasurement: (id, patch) =>
    set((s) => ({ measurements: s.measurements.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
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
}));
