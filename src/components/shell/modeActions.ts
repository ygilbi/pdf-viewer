import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { modeReducer, type ModeEvent } from '../../state/editMode';

/** Lazy edit-mode chrome (desktop palette / phone toolbar); prefetched at idle after the first page is drawn. */
export const loadEditChrome = () => import('./EditChrome');

/** Applies a mode transition to the ui + viewer stores. */
export function applyModeEvent(ev: ModeEvent): void {
  const ui = useUi.getState();
  const r = modeReducer(ui.editMode, ev);
  if (r.editMode !== ui.editMode) {
    if (r.editMode) void loadEditChrome();
    ui.setEditMode(r.editMode);
  }
  if (r.tool && useViewer.getState().tool !== r.tool) useViewer.getState().setTool(r.tool);
}

/** "מצב עריכה" / "✓ סיום עריכה" button and the Q key. */
export function toggleEditMode(): void {
  applyModeEvent({ type: 'toggle', tool: useViewer.getState().tool });
}
