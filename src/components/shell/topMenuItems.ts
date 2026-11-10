/**
 * Content of the always-visible top bar (TopMenu) — pure, so the rules unit-test without React.
 * Order = the owner's order of groups. Items that only make sense while editing are hidden in the
 * clean view mode (not just disabled), so the view mode's bar stays short.
 */
import { itemsTableAvailable } from '../../state/editMode';

export type TopMenuItemId =
  | 'open'
  | 'saveAs'
  | 'prevPage'
  | 'page'
  | 'nextPage'
  | 'zoomOut'
  | 'zoomLevel'
  | 'zoomIn'
  | 'fit'
  | 'search'
  | 'export'
  | 'gilboa'
  | 'category'
  | 'thumbs'
  | 'items'
  | 'fullscreen'
  | 'user'
  | 'logout';

export type TopMenuGroupId = 'file' | 'pages' | 'zoom' | 'search' | 'export' | 'category' | 'view' | 'user';

export interface TopMenuGroup {
  id: TopMenuGroupId;
  /** Hebrew group name (role="group" aria-label). */
  label: string;
  items: readonly TopMenuItemId[];
}

export const TOP_MENU_GROUPS: readonly TopMenuGroup[] = [
  { id: 'file', label: 'קובץ', items: ['open', 'saveAs'] },
  { id: 'pages', label: 'דפים', items: ['prevPage', 'page', 'nextPage'] },
  { id: 'zoom', label: 'זום', items: ['zoomOut', 'zoomLevel', 'zoomIn', 'fit'] },
  { id: 'search', label: 'חיפוש', items: ['search'] },
  { id: 'export', label: 'ייצוא', items: ['export', 'gilboa'] },
  // Category of NEW measurements: no other control sets it, so it stays here — edit mode only.
  { id: 'category', label: 'קטגוריה', items: ['category'] },
  { id: 'view', label: 'תצוגה', items: ['thumbs', 'items', 'fullscreen'] },
  { id: 'user', label: 'משתמש', items: ['user', 'logout'] },
];

export interface TopMenuContext {
  editMode: boolean;
  /** The Fullscreen API exists (not on iPhone Safari). */
  fullscreen: boolean;
  /** A signed-in user (the web build's auth gate); the desktop app / dev may have none. */
  signedIn: boolean;
}

/** Edit-mode-only entries: the items table panel and the category of new measurements. */
const EDIT_ONLY: ReadonlySet<TopMenuItemId> = new Set(['items', 'category', 'gilboa']);

export function isTopMenuItemVisible(id: TopMenuItemId, ctx: TopMenuContext): boolean {
  // Same rule as the M key / the drawer (state/editMode): the items table is an edit-mode panel.
  if (EDIT_ONLY.has(id) && !itemsTableAvailable(ctx)) return false;
  if (id === 'fullscreen') return ctx.fullscreen;
  if (id === 'user' || id === 'logout') return ctx.signedIn;
  return true;
}

/** The groups with their visible items, empty groups dropped. */
export function visibleTopMenu(ctx: TopMenuContext): TopMenuGroup[] {
  return TOP_MENU_GROUPS.map((g) => ({ ...g, items: g.items.filter((id) => isTopMenuItemVisible(id, ctx)) })).filter((g) => g.items.length > 0);
}
