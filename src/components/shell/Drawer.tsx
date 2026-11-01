import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUi, type DrawerId } from '../../state/uiStore';
import { IconPin } from '../ui/icons';

const ANIM_MS = 180;

/**
 * Side drawer that slides OVER the drawing (never resizes the viewer).
 * Children are only mounted while the drawer is open (plus the slide-out),
 * so a closed thumbnail drawer renders nothing.
 */
export function Drawer({
  id,
  side,
  label,
  children,
}: {
  id: DrawerId;
  side: 'left' | 'right';
  label: string;
  children: (props: { onHide: () => void; headerActions: ReactNode }) => ReactNode;
}) {
  const open = useUi((s) => (id === 'thumbs' ? s.thumbsOpen : s.measurementsOpen));
  const pinned = useUi((s) => (id === 'thumbs' ? s.thumbsPinned : s.measurementsPinned));
  const ref = useRef<HTMLDivElement>(null);

  // mount → next frame slide in; slide out → unmount after the transition.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let r2 = 0;
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(r1);
        cancelAnimationFrame(r2);
      };
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), ANIM_MS + 20);
    return () => window.clearTimeout(t);
  }, [open]);

  // Click outside closes an unpinned drawer (the click still reaches the drawing).
  useEffect(() => {
    if (!open || pinned) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t)) return;
      if (t.closest?.(`[data-drawer-toggle="${id}"]`)) return;
      // Portaled dialogs/toasts are not "outside the drawer" in intent.
      if (t.closest?.('[role="dialog"]')) return;
      useUi.getState().setDrawerOpen(id, false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, pinned, id]);

  if (!mounted) return null;

  const hide = () => useUi.getState().setDrawerOpen(id, false);
  const headerActions = (
    <button
      type="button"
      onClick={() => useUi.getState().setPinned(id, !pinned)}
      aria-pressed={pinned}
      aria-label={pinned ? 'בטל נעיצה' : 'נעץ (השאר פתוח)'}
      title={pinned ? 'בטל נעיצה' : 'נעץ — השאר פתוח'}
      data-testid={`pin-${id}`}
      className={
        'rounded p-0.5 hover:bg-slate-700 hover:text-white ' + (pinned ? 'text-sky-400' : 'text-slate-400')
      }
    >
      <IconPin size={14} className={pinned ? '' : 'rotate-45'} />
    </button>
  );

  const offscreen = side === 'right' ? 'translate-x-full' : '-translate-x-full';
  return (
    <div
      ref={ref}
      role="complementary"
      aria-label={label}
      data-testid={`drawer-${id}`}
      data-open={shown ? 'true' : 'false'}
      className={
        'absolute bottom-0 top-0 z-30 flex max-w-[calc(100vw-3rem)] bg-slate-900/90 shadow-2xl shadow-black/60 backdrop-blur ' +
        'transition-transform ease-out motion-reduce:transition-none ' +
        (side === 'right' ? 'right-0 ' : 'left-0 ') +
        (shown ? 'translate-x-0' : offscreen)
      }
      style={{ transitionDuration: `${ANIM_MS}ms` }}
    >
      {children({ onHide: hide, headerActions })}
    </div>
  );
}
