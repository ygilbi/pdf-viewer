import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { useViewer } from '../state/store';
import type { ToolId } from '../core/types';
import {
  IconAreaManual,
  IconAreaQuick,
  IconArrow,
  IconCloud,
  IconCount,
  IconDeductManual,
  IconDeductQuick,
  IconHand,
  IconHighlight,
  IconLength,
  IconNote,
  IconPen,
  IconRect,
  IconRuler,
  IconText,
} from './ui/icons';
import { isTypingTarget } from './ui/util';
import { useSnap } from '../state/snapStore';

export const DOWNLOAD_HINT = "אם ההורדה חסומה, השתמש ב'העתק טבלה'";

export type ToolGroup = 'measure' | 'markup';

export interface ToolDef {
  id: ToolId;
  /** Full name (tooltip, aria-label). */
  label: string;
  /** Short name shown next to the icon in the palette. */
  short: string;
  shortcut: string;
  icon: ReactElement;
  group: ToolGroup;
  /** Extra tooltip line. */
  hint?: string;
  /** Shown inside the expandable "חישוב שטח" menu of the palette. */
  areaMenu?: boolean;
}

/** Title of the palette's expandable area menu. */
export const AREA_MENU_LABEL = 'חישוב שטח';

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = { measure: 'מדידה', markup: 'סימון והערות' };

export const TOOLS: ToolDef[] = [
  { id: 'pan', label: 'יד / הזזה', short: 'יד / הזזה', shortcut: 'V / H', icon: <IconHand />, group: 'measure', hint: 'גרירת סימון מזיזה אותו' },
  { id: 'calibrate', label: 'כיול ידני', short: 'כיול ידני', shortcut: 'C', icon: <IconRuler />, group: 'measure' },
  { id: 'area', label: 'הוספת שטח ידנית', short: 'הוספה ידנית', shortcut: 'A', icon: <IconAreaManual />, group: 'measure', areaMenu: true, hint: 'לחיצה על כל פינה · Enter / לחיצה על הנקודה הראשונה לסגירה' },
  { id: 'rectArea', label: 'הוספת שטח מהירה', short: 'הוספה מהירה', shortcut: 'B', icon: <IconAreaQuick />, group: 'measure', areaMenu: true, hint: 'שתי לחיצות בפינות נגדיות או גרירה' },
  { id: 'deduct', label: 'הפחתת שטח ידנית', short: 'הפחתה ידנית', shortcut: 'D', icon: <IconDeductManual />, group: 'measure', areaMenu: true, hint: 'לחיצה על כל פינה של הפתח' },
  { id: 'rectDeduct', label: 'הפחתת שטח מהירה', short: 'הפחתה מהירה', shortcut: 'O', icon: <IconDeductQuick />, group: 'measure', areaMenu: true, hint: 'שתי לחיצות בפינות נגדיות או גרירה' },
  { id: 'length', label: 'חישוב אורך', short: 'חישוב אורך', shortcut: 'L', icon: <IconLength />, group: 'measure' },
  { id: 'count', label: 'ספירת פריטים', short: 'ספירה', shortcut: 'N', icon: <IconCount />, group: 'measure' },
  { id: 'note', label: 'הערה', short: 'הערה', shortcut: 'K', icon: <IconNote />, group: 'markup', hint: 'לחץ למיקום סיכה והקלד הערה' },
  { id: 'text', label: 'טקסט על השרטוט', short: 'טקסט', shortcut: 'X', icon: <IconText />, group: 'markup' },
  { id: 'rect', label: 'מלבן', short: 'מלבן', shortcut: 'R', icon: <IconRect />, group: 'markup', hint: 'גרור לציור' },
  { id: 'cloud', label: 'ענן תיקון', short: 'ענן תיקון', shortcut: 'U', icon: <IconCloud />, group: 'markup', hint: 'גרור מלבן' },
  { id: 'arrow', label: 'חץ', short: 'חץ', shortcut: 'W', icon: <IconArrow />, group: 'markup', hint: 'גרור מהזנב לראש' },
  { id: 'pen', label: 'עט חופשי', short: 'עט חופשי', shortcut: 'P', icon: <IconPen />, group: 'markup' },
  { id: 'highlight', label: 'מרקר (הדגשה)', short: 'מרקר', shortcut: 'G', icon: <IconHighlight />, group: 'markup', hint: 'גרור מלבן שקוף' },
];

/** e.code → tool (e.code so shortcuts work on a Hebrew keyboard layout too). */
const TOOL_KEYS: Record<string, ToolId> = {
  KeyV: 'pan',
  KeyH: 'pan',
  KeyC: 'calibrate',
  KeyA: 'area',
  KeyB: 'rectArea',
  KeyD: 'deduct',
  KeyO: 'rectDeduct',
  KeyL: 'length',
  KeyN: 'count',
  KeyK: 'note',
  KeyX: 'text',
  KeyR: 'rect',
  KeyU: 'cloud',
  KeyW: 'arrow',
  KeyP: 'pen',
  KeyG: 'highlight',
};

/** Global tool / page shortcuts (always active while a document is open). */
export function useToolShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const s = useViewer.getState();
      if (s.numPages === 0) return;
      if (e.code === 'KeyS' && !e.shiftKey) {
        useSnap.getState().toggle();
        e.preventDefault();
        return;
      }
      const t = TOOL_KEYS[e.code];
      if (t) {
        s.setTool(t);
        e.preventDefault();
        return;
      }
      switch (e.code) {
        case 'PageUp':
          s.setPage(s.currentPage - 1);
          break;
        case 'PageDown':
          s.setPage(s.currentPage + 1);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    // Undo / redo: Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y (Cmd on Mac). e.code → any keyboard layout.
    const onUndoKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.code !== 'KeyZ' && e.code !== 'KeyY') return;
      if (isTypingTarget(e.target)) return; // native text undo in inputs
      if (useViewer.getState().numPages === 0) return;
      e.preventDefault();
      if (e.code === 'KeyY' || e.shiftKey) redoAction();
      else undoAction();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onUndoKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onUndoKey);
    };
  }, []);
}

/** Undo: while a shape is being drawn, removes its last point; otherwise the last change. */
export function undoAction() {
  const s = useViewer.getState();
  if (s.draft.length) s.setDraft(s.draft.slice(0, -1));
  else s.undo();
}

export function redoAction() {
  useViewer.getState().redo();
}

// ---- fullscreen -------------------------------------------------------------

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

export const fullscreenSupported = () => {
  const el = document.documentElement as FsEl;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
};

const fsElement = () => document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null;

export function toggleFullscreen() {
  const d = document as FsDoc;
  try {
    if (fsElement()) {
      void (d.exitFullscreen ?? d.webkitExitFullscreen)?.call(d)?.catch?.(() => {});
    } else {
      const el = document.documentElement as FsEl;
      void (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
    }
  } catch {
    /* denied (e.g. iframe without allowfullscreen) */
  }
}

function subscribeFs(cb: () => void) {
  document.addEventListener('fullscreenchange', cb);
  document.addEventListener('webkitfullscreenchange', cb);
  return () => {
    document.removeEventListener('fullscreenchange', cb);
    document.removeEventListener('webkitfullscreenchange', cb);
  };
}

export function useIsFullscreen(): boolean {
  return useSyncExternalStore(subscribeFs, () => !!fsElement(), () => false);
}
