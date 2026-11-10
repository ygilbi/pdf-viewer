import { lazy, Suspense, useEffect } from 'react';
import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { LeftDrawerContent, toggleLeftTab } from '../../pricing/LeftDrawer';
import { IconAlert, IconX } from '../ui/icons';
import { isTypingTarget } from '../ui/util';
import { toggleFullscreen, useToolShortcuts } from '../toolActions';
import { Drawer } from './Drawer';
import { FloatingChrome } from './FloatingChrome';
import { LinkBackButton } from './LinkBackButton';
import { CountFinishButton } from './CountFinishButton';
import { HintPanel } from './HintPanel';
import { SearchHost } from '../text/searchControls';
import { openExportDialog, useExportUi } from '../../export/exportUi';
import { addedDocIds, docIdAtPage } from '../../state/editMode';
import { afterFirstPaint } from '../../state/firstPaint';
import { applyModeEvent, loadEditChrome } from './modeActions';
import { BottomSlot, CleanDock } from './ModeDock';
import { useCompactLayout } from './layout';
import { CompareBar, CompareDialog } from '../../compare/ComparePanel';

// Lazy chunks: none of these is needed to show the first page of a file.
const EditChrome = lazy(loadEditChrome);
const ExportDialog = lazy(() => import('../ExportDialog').then((m) => ({ default: m.ExportDialog })));
const ThumbnailSidebar = lazy(() => import('../ThumbnailSidebar'));

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
          // The items table is an edit-mode panel: M does nothing in the view mode.
          if (!e.shiftKey && ui.editMode) toggleLeftTab();
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

/**
 * Mode bookkeeping: every opened file (first file, added tab, restored workspace) starts in the
 * clean view mode. Nothing but the "מצב עריכה" button opens edit mode (store.setTool refuses
 * non-clean tools in the view mode). The view mode's temporary measurements are dropped when a
 * file is opened / closed or the current tab (file under the current page) changes.
 */
function useEditModeSync() {
  useEffect(() => {
    // Mounting = a workspace was just opened.
    applyModeEvent({ type: 'fileOpened', tool: useViewer.getState().tool });
    const unsub = useViewer.subscribe((s, prev) => {
      if (s.docs !== prev.docs) {
        const prevIds = prev.docs.map((d) => d.id);
        const ids = s.docs.map((d) => d.id);
        if (addedDocIds(prevIds, ids).length) applyModeEvent({ type: 'fileOpened', tool: s.tool });
        else if (addedDocIds(ids, prevIds).length) s.discardTempMeasurements(); // a file was closed
      }
      if (s.currentPage !== prev.currentPage && docIdAtPage(s.docs, s.currentPage) !== docIdAtPage(prev.docs, prev.currentPage))
        useViewer.getState().discardTempMeasurements(); // another tab
      if (s.tool !== prev.tool) applyModeEvent({ type: 'toolChanged', tool: s.tool });
    });
    // Warm the chunks the user is likely to need next, once the drawing is on screen.
    const cancel = afterFirstPaint(() => {
      void loadEditChrome();
    });
    return () => {
      unsub();
      cancel();
    };
  }, []);
}

/** All floating chrome over the full-screen viewer (rendered as a sibling of the viewer). */
// The top bar (TopMenu) is mounted by App, between the file tabs and the viewer region.
export function ViewerShell(_props: { onOpenFile(file: File): void }) {
  useToolShortcuts();
  useShellKeys();
  useEditModeSync();
  const editMode = useUi((s) => s.editMode);
  const compact = useCompactLayout();
  const exportOpen = useExportUi((s) => s.open);

  return (
    <>
      <FloatingChrome />
      {editMode && !compact && (
        <Suspense fallback={null}>
          <EditChrome variant="palette" />
        </Suspense>
      )}
      <BottomSlot compact={compact} flush={editMode && compact}>
        <LinkBackButton />
        <CountFinishButton />
        <HintPanel />
        {!editMode ? (
          <CleanDock compact={compact} />
        ) : compact ? (
          <Suspense fallback={null}>
            <EditChrome variant="bar" />
          </Suspense>
        ) : null}
      </BottomSlot>
      <Drawer id="thumbs" side="right" label="תצוגת דפים">
        {(p) => (
          <Suspense fallback={null}>
            <ThumbnailSidebar {...p} />
          </Suspense>
        )}
      </Drawer>
      {editMode && (
        <Drawer id="measurements" side="left" label="רשימת מדידות">
          {(p) => <LeftDrawerContent {...p} />}
        </Drawer>
      )}
      <SearchHost />
      <CompareBar />
      <CompareDialog />
      {exportOpen && (
        <Suspense fallback={null}>
          <ExportDialog />
        </Suspense>
      )}
    </>
  );
}

/** Floating error banner (top-centre, under the pill). */
export function ErrorToast() {
  const error = useViewer((s) => s.error);
  const setError = useViewer((s) => s.setError);
  const hasDocs = useViewer((s) => s.docs.length > 0);
  if (!error) return null;
  return (
    <div
      role="alert"
      data-testid="error-toast"
      className={
        (hasDocs ? 'top-[8.5rem] ' : 'top-14 ') +
        'absolute left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-md border border-red-800 bg-red-950/90 px-3 py-2 text-sm text-red-200 shadow-xl backdrop-blur'
      }
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
