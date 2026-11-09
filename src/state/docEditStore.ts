import { create } from 'zustand';
import type { AreaMeasurement } from '../core/types';

/**
 * A NEW 'textEdit' being typed (edit-text tool): kept out of the measurements until it is
 * committed, so creating one is a single undo step (add) and cancelling leaves no trace.
 * Editing an existing one goes through markupStore.editingId as usual.
 */
interface DocEditState {
  pending: AreaMeasurement | null;
  setPending(m: AreaMeasurement | null): void;
}

export const useDocEdit = create<DocEditState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
}));
