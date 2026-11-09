import { create } from 'zustand';

/**
 * Signature tool state: signatures saved on this device (localStorage — they never leave it) and
 * the one currently being placed. A placed signature is a VISUAL signature (an image on the page),
 * not a certified / cryptographic digital signature.
 */
export interface SavedSignature {
  id: string;
  /** Trimmed transparent PNG as a data URL (≤ ~60 KB). */
  image: string;
  /** width / height */
  aspect: number;
  createdAt: number;
}

interface SignatureState {
  saved: SavedSignature[];
  /** The create / choose dialog is open. */
  dialogOpen: boolean;
  /** Signature being placed (ghost follows the pointer), null = none chosen yet. */
  active: { image: string; aspect: number } | null;
  /** Add a date line under newly placed signatures. */
  withDate: boolean;
  openDialog(): void;
  closeDialog(): void;
  /** Use this signature for the next placement (closes the dialog). */
  choose(sig: { image: string; aspect: number }): void;
  /** Save a new signature on this device and choose it. */
  add(sig: { image: string; aspect: number }): void;
  remove(id: string): void;
  setWithDate(v: boolean): void;
  /** Placement finished / cancelled. */
  clearActive(): void;
}

const KEY = 'pdf-viewer-signatures-v1';
const PREF_KEY = 'pdf-viewer-signature-prefs-v1';
/** At most this many saved signatures (oldest dropped). */
const MAX_SAVED = 8;

function load(): SavedSignature[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (s): s is SavedSignature =>
        !!s && typeof s.id === 'string' && typeof s.image === 'string' && s.image.startsWith('data:image/') && typeof s.aspect === 'number' && s.aspect > 0,
    );
  } catch {
    return [];
  }
}

function persist(list: SavedSignature[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full / blocked: the signature still works for this session */
  }
}

function loadWithDate(): boolean {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}').withDate === true;
  } catch {
    return false;
  }
}

export const useSignatures = create<SignatureState>((set, get) => ({
  saved: load(),
  dialogOpen: false,
  active: null,
  withDate: loadWithDate(),
  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
  choose: (sig) => set({ active: { image: sig.image, aspect: sig.aspect }, dialogOpen: false }),
  add: (sig) => {
    const entry: SavedSignature = { id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, image: sig.image, aspect: sig.aspect, createdAt: Date.now() };
    const saved = [entry, ...get().saved.filter((s) => s.image !== sig.image)].slice(0, MAX_SAVED);
    persist(saved);
    set({ saved, active: { image: sig.image, aspect: sig.aspect }, dialogOpen: false });
  },
  remove: (id) => {
    const saved = get().saved.filter((s) => s.id !== id);
    persist(saved);
    set({ saved });
  },
  setWithDate: (withDate) => {
    set({ withDate });
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ withDate }));
    } catch {
      /* per-device convenience only */
    }
  },
  clearActive: () => set({ active: null }),
}));
