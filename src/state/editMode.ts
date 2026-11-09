import type { ToolId } from '../core/types';

/**
 * Viewer modes. Every opened file starts in the CLEAN view mode (drawing + a small dock with
 * calibrate / area / length + "מצב עריכה"); EDIT mode shows every tool (desktop palette / phone
 * toolbar). The only way in is the "מצב עריכה" button; the only way out is opening a file.
 * Measurements made in the view mode are temporary (core/tempMeasurements).
 * Pure: the transitions are unit-tested; the store wiring lives in uiStore / useEditModeSync.
 */

/** Tools reachable from the clean dock: hand, calibrate and the area menu (rectangle / polygon, add / deduct). */
export const CLEAN_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(['pan', 'calibrate', 'rectArea', 'rectDeduct', 'area', 'deduct', 'length']);

export const isCleanTool = (tool: ToolId): boolean => CLEAN_TOOLS.has(tool);

export type ModeEvent =
  /** The "מצב עריכה" button — the ONLY way into edit mode. There is no way back except opening a file. */
  | { type: 'enterEdit'; tool: ToolId }
  /** The active tool changed (shortcut, items panel, menu…). Never changes the mode. */
  | { type: 'toolChanged'; tool: ToolId }
  /** A file was opened or added to the workspace (or the app started with a restored one). */
  | { type: 'fileOpened'; tool: ToolId };

export interface ModeResult {
  editMode: boolean;
  /** Tool to switch to (only when the current one is not available in the new mode). */
  tool?: ToolId;
  /** Drop the view-mode quick checks (temporary measurements). */
  discardTemp?: boolean;
}

function toClean(tool: ToolId): ModeResult {
  return isCleanTool(tool) ? { editMode: false } : { editMode: false, tool: 'pan' };
}

export function modeReducer(editMode: boolean, ev: ModeEvent): ModeResult {
  switch (ev.type) {
    case 'enterEdit':
      // The quick checks made in the view mode are not carried into the edit session.
      return editMode ? { editMode } : { editMode: true, discardTemp: true };
    case 'toolChanged':
      // Safety net: store.setTool already refuses non-clean tools in the view mode.
      return editMode || isCleanTool(ev.tool) ? { editMode } : { editMode, tool: 'pan' };
    case 'fileOpened':
      return { ...toClean(ev.tool), discardTemp: true };
  }
}

/** Keyboard tool shortcuts: in the view mode only the clean-dock tools (hand, C, A/B/D/O, L) react. */
export function toolShortcutAllowed(editMode: boolean, tool: ToolId): boolean {
  return editMode || isCleanTool(tool);
}

/** The items table (left drawer, M, menu entry) exists in edit mode only. */
export const itemsTableAvailable = (ui: { editMode: boolean }): boolean => ui.editMode;

/** Global page → id of the file it belongs to (the "current tab"). */
export function docIdAtPage(docs: readonly { id: string; pageOffset: number; numPages: number }[], page: number): string | null {
  return docs.find((d) => page > d.pageOffset && page <= d.pageOffset + d.numPages)?.id ?? null;
}

/** Ids of docs in `next` that were not in `prev` (a file opened / tab added). */
export function addedDocIds(prev: readonly string[], next: readonly string[]): string[] {
  const p = new Set(prev);
  return next.filter((id) => !p.has(id));
}
