import { create } from 'zustand';

/** Geometry-snap toggle (per device, remembered). Hold Ctrl to bypass it momentarily. */
const KEY = 'aluminum-snap-v1';

function load(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

interface SnapState {
  enabled: boolean;
  setEnabled(on: boolean): void;
  toggle(): void;
}

export const useSnap = create<SnapState>((set, get) => ({
  enabled: load(),
  setEnabled: (enabled) => {
    set({ enabled });
    try {
      localStorage.setItem(KEY, enabled ? '1' : '0');
    } catch {
      /* ignore */
    }
  },
  toggle: () => get().setEnabled(!get().enabled),
}));
