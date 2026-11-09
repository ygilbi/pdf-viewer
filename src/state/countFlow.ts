import { create } from 'zustand';
import { useViewer } from './store';
import { kindOf } from '../core/measurementEngine';

/**
 * Counting flow (ספירה): the first tap of a new item places marker 1, then the item is MEASURED
 * once (two opposite corners / a drag over the window on the drawing) → its width × height go into
 * the items table; after that every tap marks another item of the same type, until Enter /
 * "סיום" / "+ פריט חדש". `measuringId` = the count group waiting for its measurement.
 */
interface CountFlowState {
  measuringId: string | null;
  start(id: string): void;
  done(): void;
}

export const useCountFlow = create<CountFlowState>((set) => ({
  measuringId: null,
  start: (measuringId) => set({ measuringId }),
  done: () => set({ measuringId: null }),
}));

/** Leaving the count tool, or the group being deselected / deleted, ends the measuring step. */
useViewer.subscribe((s) => {
  const id = useCountFlow.getState().measuringId;
  if (!id) return;
  const m = s.measurements.find((x) => x.id === id);
  if (s.tool !== 'count' || s.selectedId !== id || !m || kindOf(m) !== 'count') useCountFlow.getState().done();
});
