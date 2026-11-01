import { useEffect } from 'react';
import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import ThumbnailSidebar from '../ThumbnailSidebar';
import MeasurementsPanel from '../MeasurementsPanel';
import { IconAlert, IconX } from '../ui/icons';
import { isTypingTarget } from '../ui/util';
import { toggleFullscreen, useToolShortcuts } from '../toolActions';
import { Drawer } from './Drawer';
import { FloatingChrome } from './FloatingChrome';
import { TopMenu } from './TopMenu';
import { ToolPalette } from './ToolPalette';
import { ExportDialog } from '../ExportDialog';
import { openExportDialog, useExportUi } from '../../export/exportUi';

/**
 * Shell keys. Registered in the CAPTURE phase on window so they run before
 * ViewerCanvas's own window listener — Shift+F must not also "fit", and an
 * Esc that closes a menu/drawer must not also cancel a draft.
 */
function useShellKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (useViewer.getState().numPages === 0) return;
      if (useExportUi.getState().open) return; // the export dialog handles its own keys
      const ui = useUi.getState();
      let handled = true;
      switch (e.code) {
        case 'KeyF':
          if (e.shiftKey) toggleFullscreen();
          else handled = false;
          break;
        case 'KeyT':
          if (!e.shiftKey) ui.toggleDrawer('thumbs');
          else handled = false;
          break;
        case 'KeyE':
          if (!e.shiftKey) {
            ui.setMenuOpen(false);
            openExportDialog();
          } else handled = false;
          break;
        case 'KeyM':
          if (!e.shiftKey) ui.toggleDrawer('measurements');
          else handled = false;
          break;
        case 'Escape':
          if (ui.menuOpen) ui.setMenuOpen(false);
          else if ((ui.thumbsOpen && !ui.thumbsPinned) || (ui.measurementsOpen && !ui.measurementsPinned)) {
            if (!ui.thumbsPinned) ui.setDrawerOpen('thumbs', false);
            if (!ui.measurementsPinned) ui.setDrawerOpen('measurements', false);
          } else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/** All floating chrome over the full-screen viewer (rendered as a sibling of the viewer). */
export function ViewerShell({ onOpenFile }: { onOpenFile(file: File): void }) {
  useToolShortcuts();
  useShellKeys();
  return (
    <>
      <FloatingChrome />
      <ToolPalette />
      <Drawer id="thumbs" side="right" label="תצוגת דפים">
        {(p) => <ThumbnailSidebar {...p} />}
      </Drawer>
      <Drawer id="measurements" side="left" label="רשימת מדידות">
        {(p) => <MeasurementsPanel {...p} />}
      </Drawer>
      <TopMenu onOpenFile={onOpenFile} />
      <ExportDialog />
    </>
  );
}

/** Floating error banner (top-centre, under the pill). */
export function ErrorToast() {
  const error = useViewer((s) => s.error);
  const setError = useViewer((s) => s.setError);
  if (!error) return null;
  return (
    <div
      role="alert"
      data-testid="error-toast"
      className="absolute left-1/2 top-14 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-md border border-red-800 bg-red-950/90 px-3 py-2 text-sm text-red-200 shadow-xl backdrop-blur"
    >
      <IconAlert className="shrink-0 text-red-400" />
      <span className="flex-1">{error}</span>
      <button
        type="button"
        onClick={() => setError(null)}
        aria-label="סגור הודעה"
        className="rounded p-0.5 text-red-300 hover:bg-red-900 hover:text-white"
      >
        <IconX size={14} />
      </button>
    </div>
  );
}
