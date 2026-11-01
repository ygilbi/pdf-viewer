import { create } from 'zustand';
import type { AreaMeasurement, Calibration, PageSize, Point, ToolId } from '../core/types';

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
}));
