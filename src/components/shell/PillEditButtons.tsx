import { useViewer } from '../../state/store';
import { useSnap } from '../../state/snapStore';
import { redoAction, undoAction } from '../toolActions';
import { IconRedo, IconSnap, IconUndo } from '../ui/icons';

const btn =
  'flex h-8 min-w-8 items-center justify-center rounded-full px-1.5 text-xs text-slate-200 transition-colors ' +
  'hover:bg-slate-700/80 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 ' +
  'disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = isMac ? '⌘' : 'Ctrl';

/** Undo / redo + geometry-snap toggle for the floating status pill. */
export function PillEditButtons() {
  const canUndo = useViewer((s) => s.historyPast.length > 0 || s.draft.length > 0);
  const canRedo = useViewer((s) => s.historyFuture.length > 0);
  const snap = useSnap((s) => s.enabled);
  const toggleSnap = useSnap((s) => s.toggle);
  return (
    <>
      <span className="mx-0.5 h-4 w-px bg-slate-600" aria-hidden="true" />
      {/* RTL pill: undo sits first (right), redo after it */}
      <button
        type="button"
        onClick={undoAction}
        disabled={!canUndo}
        title={`בטל (${mod}+Z)`}
        aria-label="בטל פעולה"
        className={btn}
        data-testid="pill-undo"
      >
        <IconUndo style={{ transform: 'scaleX(-1)' }} />
      </button>
      <button
        type="button"
        onClick={redoAction}
        disabled={!canRedo}
        title={`בצע שוב (${mod}+Shift+Z / ${mod}+Y)`}
        aria-label="בצע שוב"
        className={btn}
        data-testid="pill-redo"
      >
        <IconRedo style={{ transform: 'scaleX(-1)' }} />
      </button>
      <button
        type="button"
        onClick={toggleSnap}
        aria-pressed={snap}
        title={`הצמדה לשרטוט: ${snap ? 'פעילה' : 'כבויה'} (S · החזק Ctrl לביטול זמני)`}
        aria-label="הצמדה לקווי השרטוט"
        className={btn + (snap ? ' text-emerald-300' : ' bg-amber-500/20 text-amber-400')}
        data-testid="pill-snap"
      >
        <span className="relative inline-flex">
          <IconSnap />
          {!snap && (
            // Off: a clear diagonal strike-through (grey alone was easy to miss on a phone).
            <svg className="absolute inset-0" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 14 14 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
        </span>
      </button>
      <span className="mx-0.5 h-4 w-px bg-slate-600" aria-hidden="true" />
    </>
  );
}
