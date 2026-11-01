import { create } from 'zustand';

/** Open/close state of the export dialog (separate from uiStore so toggling it re-renders nothing else). */
export const useExportUi = create<{ open: boolean; setOpen(open: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export const openExportDialog = () => useExportUi.getState().setOpen(true);
