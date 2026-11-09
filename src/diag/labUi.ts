import { create } from 'zustand';

export const useLabUi = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
