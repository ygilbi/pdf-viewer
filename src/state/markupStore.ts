import { create } from 'zustand';
import { DEFAULT_STROKE_WIDTH } from '../core/markupGeometry';

/**
 * Markup UI state: which note / text annotation is being edited, and the
 * style (colour / stroke width) given to new markup. Separate from the viewer
 * store so editing a comment never re-renders the canvas tree.
 */
interface MarkupUiState {
  /** Annotation whose text is being edited in place (note / text). */
  editingId: string | null;
  /** True while editing an annotation that was just created (cancel → remove it). */
  editingIsNew: boolean;
  /** Colour for new markup; null = follow the active category (or the default). */
  color: string | null;
  strokeWidth: number;
  startEditing(id: string, isNew?: boolean): void;
  stopEditing(): void;
  setColor(color: string | null): void;
  setStrokeWidth(w: number): void;
}

const KEY = 'aluminum-markup-style-v1';

function load(): { color?: string | null; strokeWidth?: number } {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function save(s: { color: string | null; strokeWidth: number }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ color: s.color, strokeWidth: s.strokeWidth }));
  } catch {
    /* per-viewer convenience only */
  }
}

const saved = load();

export const useMarkup = create<MarkupUiState>((set, get) => ({
  editingId: null,
  editingIsNew: false,
  color: typeof saved.color === 'string' && /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : null,
  strokeWidth: typeof saved.strokeWidth === 'number' && saved.strokeWidth > 0 ? saved.strokeWidth : DEFAULT_STROKE_WIDTH,
  startEditing: (id, isNew = false) => set({ editingId: id, editingIsNew: isNew }),
  stopEditing: () => set({ editingId: null, editingIsNew: false }),
  setColor: (color) => {
    set({ color });
    save(get());
  },
  setStrokeWidth: (strokeWidth) => {
    set({ strokeWidth });
    save(get());
  },
}));
