import { create } from 'zustand';
import { useViewer } from './store';

/** One followed link: from which page to which page (global page numbers). */
export interface LinkHop {
  from: number;
  to: number;
  /** Link name shown on the back button's tooltip (e.g. "A1"). */
  name?: string;
}

interface LinkHistoryState {
  hops: LinkHop[];
  clear(): void;
}

/**
 * Pages reached by following link callouts, so the target page can show a "חזור" button.
 * Chains work (A → B → C, back to B, back to A). Navigating anywhere else by other means
 * (thumbnails, keys, tabs…) forgets the trail, see {@link reconcileLinkHistory}.
 */
export const useLinkHistory = create<LinkHistoryState>((set) => ({
  hops: [],
  clear: () => set({ hops: [] }),
}));

const MAX_HOPS = 50;

/** Follow a link: remember where we came from, then go. */
export function followLink(to: number, name?: string): void {
  const v = useViewer.getState();
  const from = v.currentPage;
  if (!to || to === from) return;
  const hops = useLinkHistory.getState().hops;
  useLinkHistory.setState({ hops: [...hops, { from, to, name }].slice(-MAX_HOPS) });
  v.setPage(to);
}

/** Go back along the last hop. Returns false when there is nothing to go back to. */
export function goBackLink(): boolean {
  const hops = useLinkHistory.getState().hops;
  const top = hops[hops.length - 1];
  if (!top || useViewer.getState().currentPage !== top.to) return false;
  useLinkHistory.setState({ hops: hops.slice(0, -1) });
  useViewer.getState().setPage(top.from);
  return true;
}

/** Pure: keep the trail only while we are on the last hop's target page. */
export function reconcileHops(hops: LinkHop[], currentPage: number): LinkHop[] {
  const top = hops[hops.length - 1];
  return top && top.to !== currentPage ? [] : hops;
}

/** Drop the trail when the user leaves the target page some other way, or files change. */
export function reconcileLinkHistory(): () => void {
  let docs = useViewer.getState().docs;
  return useViewer.subscribe((s) => {
    const hops = useLinkHistory.getState().hops;
    if (!hops.length) {
      docs = s.docs;
      return;
    }
    if (s.docs !== docs) {
      docs = s.docs;
      useLinkHistory.getState().clear(); // page numbers may have shifted
      return;
    }
    const next = reconcileHops(hops, s.currentPage);
    if (next !== hops) useLinkHistory.setState({ hops: next });
  });
}
