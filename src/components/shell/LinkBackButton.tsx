import { useEffect } from 'react';
import { useViewer } from '../../state/store';
import { goBackLink, reconcileLinkHistory, useLinkHistory } from '../../state/linkHistory';
import { isTypingTarget } from '../ui/util';

/**
 * Prominent "חזור" button on a page reached through a link callout; returns to the page the link
 * was on. Alt+← / Backspace-free: Alt+ArrowRight (RTL "back") also goes back.
 */
export function LinkBackButton() {
  const hops = useLinkHistory((s) => s.hops);
  const currentPage = useViewer((s) => s.currentPage);
  const top = hops[hops.length - 1];
  const show = !!top && top.to === currentPage;

  useEffect(() => reconcileLinkHistory(), []);
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target)) return;
      if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        if (goBackLink()) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show]);

  if (!show) return null;
  return (
    // Rendered inside the bottom slot (stacked above the dock / edit toolbar, never over it).
    <div className="pointer-events-none flex justify-center" data-viewer-ui>
      <button
        type="button"
        dir="rtl"
        onClick={() => goBackLink()}
        title={`חזור לעמוד ${top.from}${top.name ? ` (מקישור ${top.name})` : ''} · Alt+→`}
        data-testid="link-back"
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-amber-400 px-6 py-3 text-base font-bold text-slate-900 shadow-xl shadow-black/40 ring-2 ring-white/80 transition hover:bg-amber-300 focus:outline-none focus-visible:ring-4 focus-visible:ring-sky-400 active:scale-95"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        חזור
        <span className="text-sm font-semibold opacity-75">לעמוד {top.from}</span>
      </button>
    </div>
  );
}
