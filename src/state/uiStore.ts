import { create } from 'zustand';

/**
 * Chrome state for the full-screen viewer shell (menu, drawers, palette).
 * Kept separate from the viewer store so toggling UI never re-renders the
 * canvas or anything subscribed to document state.
 */
export type DrawerId = 'thumbs' | 'measurements';

interface UiState {
  menuOpen: boolean;
  thumbsOpen: boolean;
  measurementsOpen: boolean;
  thumbsPinned: boolean;
  measurementsPinned: boolean;
  paletteCollapsed: boolean;
  setMenuOpen(open: boolean): void;
  setDrawerOpen(id: DrawerId, open: boolean): void;
  toggleDrawer(id: DrawerId): void;
  setPinned(id: DrawerId, pinned: boolean): void;
  setPaletteCollapsed(collapsed: boolean): void;
}

const KEY = 'aluminum-ui-v1';
interface Saved {
  thumbsPinned?: boolean;
  measurementsPinned?: boolean;
  paletteCollapsed?: boolean;
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : {};
  } catch {
    return {};
  }
}

function save(s: UiState) {
  try {
    const v: Saved = {
      thumbsPinned: s.thumbsPinned,
      measurementsPinned: s.measurementsPinned,
      paletteCollapsed: s.paletteCollapsed,
    };
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable — per-viewer convenience only */
  }
}

/** Narrow screens: two drawers side by side would cover the whole drawing. */
const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < 720;

const saved = load();
const openKey = (id: DrawerId): 'thumbsOpen' | 'measurementsOpen' => (id === 'thumbs' ? 'thumbsOpen' : 'measurementsOpen');
const pinKey = (id: DrawerId): 'thumbsPinned' | 'measurementsPinned' =>
  id === 'thumbs' ? 'thumbsPinned' : 'measurementsPinned';
const other = (id: DrawerId): DrawerId => (id === 'thumbs' ? 'measurements' : 'thumbs');

export const useUi = create<UiState>((set, get) => ({
  menuOpen: false,
  thumbsPinned: !!saved.thumbsPinned,
  measurementsPinned: !!saved.measurementsPinned,
  // A pinned drawer comes back open.
  thumbsOpen: !!saved.thumbsPinned && !isNarrow(),
  measurementsOpen: !!saved.measurementsPinned && !isNarrow(),
  paletteCollapsed: !!saved.paletteCollapsed,

  setMenuOpen: (menuOpen) => set({ menuOpen }),
  setDrawerOpen: (id, open) => {
    const patch: Partial<UiState> = { [openKey(id)]: open };
    if (open && isNarrow()) patch[openKey(other(id))] = false;
    if (open) patch.menuOpen = false;
    set(patch);
  },
  toggleDrawer: (id) => get().setDrawerOpen(id, !get()[openKey(id)]),
  setPinned: (id, pinned) => {
    set({ [pinKey(id)]: pinned } as Partial<UiState>);
    save(get());
  },
  setPaletteCollapsed: (paletteCollapsed) => {
    set({ paletteCollapsed });
    save(get());
  },
}));
