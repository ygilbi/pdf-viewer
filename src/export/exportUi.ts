import { create } from 'zustand';
import type { ExportFormat } from './types';

/** Open/close state of the export dialog (separate from uiStore so toggling it re-renders nothing else). */
export const useExportUi = create<{ open: boolean; format: ExportFormat | null; setOpen(open: boolean, format?: ExportFormat): void }>(
  (set) => ({
    open: false,
    /** Format to preselect when the dialog opens (null = PDF). */
    format: null,
    setOpen: (open, format) => set({ open, format: format ?? null }),
  }),
);

export const openExportDialog = (format?: ExportFormat) => useExportUi.getState().setOpen(true, format);
