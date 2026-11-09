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
import { addedDocIds, EDIT_MODE_KEY } from '../../state/editMode';
import { afterFirstPaint, useAfterFirstPaint } from '../../state/firstPaint';
import { applyModeEvent, loadEditChrome, toggleEditMode } from './modeActions';
import { BottomSlot, CleanDock, EditDockStub, EditModeToggle } from './ModeDock';
import { useCompactLayout } from './layout';

// Lazy chunks: none of these is needed to show the first page of a file.
const EditChrome = lazy(loadEditChrome);
const loadTopMenu = () => import('./TopMenu');
const TopMenu = lazy(() => loadTopMenu().then((m) => ({ default: m.TopMenu })));
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
          if (!e.shiftKey) toggleLeftTab();
          else handled = false;
          break;
        case EDIT_MODE_KEY:
          if (!e.shiftKey && !e.repeat) toggleEditMode();
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
 * clean mode; a tool that is not in the clean dock (shortcut, "+ פריט חדש"…) switches to edit mode.
 */
function useEditModeSync() {
  useEffect(() => {
    // Mounting = a workspace was just opened.
    applyModeEvent({ type: 'fileOpened', tool: useViewer.getState().tool });
    const unsub = useViewer.subscribe((s, prev) => {
      if (s.docs !== prev.docs) {
        const added = addedDocIds(
          prev.docs.map((d) => d.id),
          s.docs.map((d) => d.id),
        );
        if (added.length) applyModeEvent({ type: 'fileOpened', tool: s.tool });
      }
      if (s.tool !== prev.tool) applyModeEvent({ type: 'toolChanged', tool: s.tool });
    });
    // Warm the chunks the user is likely to need next, once the drawing is on screen.
    const cancel = afterFirstPaint(() => {
      void loadEditChrome();
      void loadTopMenu();
    });
    return () => {
      unsub();
      cancel();
    };
  }, []);
}

/** All floating chrome over the full-screen viewer (rendered as a sibling of the viewer). */
export function ViewerShell({ onOpenFile }: { onOpenFile(file: File): void }) {
  useToolShortcuts();
  useShellKeys();
  useEditModeSync();
  const editMode = useUi((s) => s.editMode);
  const compact = useCompactLayout();
  const menuMounted = useUi((s) => s.menuMounted);
  const idle = useAfterFirstPaint();
  const exportOpen = useExportUi((s) => s.open);
  const toggle = <EditModeToggle compact />;

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
          <Suspense fallback={<EditDockStub compact />}>
            <EditChrome variant="bar" toggle={toggle} />
          </Suspense>
        ) : (
          <EditDockStub compact={false} />
        )}
      </BottomSlot>
      <Drawer id="thumbs" side="right" label="תצוגת דפים">
        {(p) => (
          <Suspense fallback={null}>
            <ThumbnailSidebar {...p} />
          </Suspense>
        )}
      </Drawer>
      <Drawer id="measurements" side="left" label="רשימת מדידות">
        {(p) => <LeftDrawerContent {...p} />}
      </Drawer>
      {(menuMounted || idle) && (
        <Suspense fallback={null}>
          <TopMenu onOpenFile={onOpenFile} />
        </Suspense>
      )}
      <SearchHost />
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
        (hasDocs ? 'top-[5.5rem] ' : 'top-14 ') +
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
