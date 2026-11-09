import { describe, expect, it } from 'vitest';
import { TOP_MENU_GROUPS, isTopMenuItemVisible, visibleTopMenu } from './topMenuItems';

const view = { editMode: false, fullscreen: true, signedIn: true };
const edit = { ...view, editMode: true };
const ids = (ctx: typeof view) => visibleTopMenu(ctx).flatMap((g) => g.items);

describe('top menu', () => {
  it('keeps the owner\u2019s group order', () => {
    expect(TOP_MENU_GROUPS.map((g) => g.label)).toEqual(['קובץ', 'דפים', 'זום', 'חיפוש', 'ייצוא', 'קטגוריה', 'תצוגה', 'משתמש']);
  });
  it('hides the items table and the category in the view mode, shows them in edit mode', () => {
    expect(isTopMenuItemVisible('items', view)).toBe(false);
    expect(isTopMenuItemVisible('category', view)).toBe(false);
    expect(isTopMenuItemVisible('items', edit)).toBe(true);
    expect(isTopMenuItemVisible('category', edit)).toBe(true);
    expect(visibleTopMenu(view).map((g) => g.id)).not.toContain('category');
  });
  it('always shows the essentials', () => {
    for (const ctx of [view, edit]) {
      expect(ids(ctx)).toEqual(expect.arrayContaining(['open', 'saveAs', 'prevPage', 'page', 'nextPage', 'zoomOut', 'zoomIn', 'fit', 'search', 'export', 'thumbs']));
    }
  });
  it('drops fullscreen without the API and the user group when signed out', () => {
    expect(ids({ ...view, fullscreen: false })).not.toContain('fullscreen');
    const out = visibleTopMenu({ ...view, signedIn: false });
    expect(out.map((g) => g.id)).not.toContain('user');
  });
  it('has no removed entries', () => {
    const all = TOP_MENU_GROUPS.flatMap((g) => g.items) as string[];
    for (const gone of ['diagReport', 'install', 'defaultApp', 'downloadWindows', 'calibration']) expect(all).not.toContain(gone);
  });
});
