import { lazy, Suspense, useEffect } from 'react';
import { useViewer } from '../../state/store';
import { useSearch } from '../../text/searchStore';
import { isTypingTarget } from '../ui/util';

/**
 * Always-loaded half of the search UI: the icon, the open/focus helpers and the F3 / Ctrl+F keys.
 * The panel itself (SearchPanel.tsx) is a lazy chunk mounted only while open.
 */
export const IconSearch = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

/** The search box in the file tab bar (Ctrl+F focuses it). */
export const TABBAR_SEARCH_SELECTOR = '[data-testid="tabbar-search"]';

/** Focuses the tab bar's "search in files" box; falls back to the panel. */
export function focusTabbarSearch(): void {
  const el = document.querySelector<HTMLInputElement>(TABBAR_SEARCH_SELECTOR);
  if (!el || el.offsetParent === null) return openSearch();
  el.focus();
  el.select();
}

/** Opens the search panel and focuses its input (F3 / Ctrl+F / menu). */
export function openSearch(): void {
  useSearch.getState().setOpen(true);
  // The panel is a lazy chunk: on the first open its input appears a few frames later.
  let tries = 90;
  const focus = () => {
    const el = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
    if (el) {
      el.focus();
      el.select();
    } else if (--tries > 0 && useSearch.getState().open) requestAnimationFrame(focus);
  };
  requestAnimationFrame(focus);
}

/** F3 / Ctrl+F open (F3 again = next, Shift+F3 = previous). Capture phase: beats the browser's find bar. */
function useSearchKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useViewer.getState().numPages === 0) return;
      const isF3 = e.key === 'F3';
      const isCtrlF = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyF';
      if (!isF3 && !isCtrlF) return;
      if (
        isCtrlF &&
        isTypingTarget(e.target) &&
        !(e.target as HTMLElement).closest('[data-testid="search-panel"]') &&
        !(e.target as HTMLElement).matches(TABBAR_SEARCH_SELECTOR)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      const s = useSearch.getState();
      if (isF3 && s.open && s.results.length) {
        const n = s.results.length;
        s.goTo(((s.activeIndex < 0 ? (e.shiftKey ? 0 : -1) : s.activeIndex) + (e.shiftKey ? -1 : 1) + n) % n);
        return;
      }
      if (isCtrlF) focusTabbarSearch();
      else openSearch();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

const SearchPanelBody = lazy(() => import('./SearchPanel'));

/** Mounted with the viewer: shortcuts + result reset; loads the panel on first open. */
export function SearchHost() {
  useSearchKeys();
  const open = useSearch((s) => s.open);
  // A changed workspace (file added/removed/reordered) invalidates page numbers of results.
  const layoutKey = useViewer((s) => s.docs.map((d) => `${d.id}:${d.pageOffset}:${d.numPages}`).join('|'));
  useEffect(() => {
    useSearch.getState().clear();
  }, [layoutKey]);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <SearchPanelBody />
    </Suspense>
  );
}
