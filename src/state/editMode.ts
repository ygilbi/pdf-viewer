import type { ToolId } from '../core/types';

/**
 * Viewer modes. Every opened file starts in the CLEAN mode (drawing + a small dock with
 * calibrate / area + "מצב עריכה"); EDIT mode shows every tool (desktop palette / phone toolbar).
 * Pure: the transitions are unit-tested; the store wiring lives in uiStore / useEditModeSync.
 */

/** Tools reachable from the clean dock: hand, calibrate and the area menu (rectangle / polygon, add / deduct). */
export const CLEAN_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(['pan', 'calibrate', 'rectArea', 'rectDeduct', 'area', 'deduct', 'length']);

export const isCleanTool = (tool: ToolId): boolean => CLEAN_TOOLS.has(tool);

/** Key that toggles edit mode (e.code, so it works on a Hebrew layout too). */
export const EDIT_MODE_KEY = 'KeyQ';
export const EDIT_MODE_KEY_LABEL = 'Q';

export type ModeEvent =
  /** The "מצב עריכה" / "סיום עריכה" button or Q. */
  | { type: 'toggle'; tool: ToolId }
  | { type: 'exit'; tool: ToolId }
  /** The active tool changed (shortcut, items panel, menu…). */
  | { type: 'toolChanged'; tool: ToolId }
  /** A file was opened or added to the workspace (or the app started with a restored one). */
  | { type: 'fileOpened'; tool: ToolId };

export interface ModeResult {
  editMode: boolean;
  /** Tool to switch to (only when the current one is not available in the new mode). */
  tool?: ToolId;
}

function toClean(tool: ToolId): ModeResult {
  return isCleanTool(tool) ? { editMode: false } : { editMode: false, tool: 'pan' };
}

export function modeReducer(editMode: boolean, ev: ModeEvent): ModeResult {
  switch (ev.type) {
    case 'toggle':
      return editMode ? toClean(ev.tool) : { editMode: true };
    case 'exit':
      return toClean(ev.tool);
    case 'toolChanged':
      // A tool that is not in the clean dock (shortcut K, X, L, N…, "+ פריט חדש") opens edit mode so nothing is lost.
      return editMode || isCleanTool(ev.tool) ? { editMode } : { editMode: true };
    case 'fileOpened':
      return toClean(ev.tool);
  }
}

/** Ids of docs in `next` that were not in `prev` (a file opened / tab added). */
export function addedDocIds(prev: readonly string[], next: readonly string[]): string[] {
  const p = new Set(prev);
  return next.filter((id) => !p.has(id));
}
