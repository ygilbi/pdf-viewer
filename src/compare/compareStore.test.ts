import { describe, expect, it } from 'vitest';
import { changesOnPage, compareTotals, shownRegions } from './compareStore';

const r = (kind: 'added' | 'removed' | 'modified') => ({ kind, x: 0, y: 0, width: 0.1, height: 0.1 });
const base = {
  oldId: 'o',
  newId: 'n',
  regions: { n: { 1: [r('added'), r('modified')], 2: [r('removed')], 3: [{ x: 0, y: 0, width: 1, height: 1 }] }, o: { 1: [r('added'), r('modified')], 4: [{ x: 0, y: 0, width: 1, height: 1 }] } },
  notes: { n: { 3: 'added' as const }, o: { 4: 'removed' as const } },
  filter: { added: true, removed: true, modified: true },
};

describe('compareStore', () => {
  it('totals count the new version plus old-only pages, by kind', () => {
    expect(compareTotals(base)).toEqual({ changes: 5, pages: 4, byKind: { added: 2, removed: 2, modified: 1 } });
  });
  it('the type filter hides changes from counts and pages', () => {
    const f = { ...base, filter: { added: false, removed: true, modified: true } };
    expect(compareTotals(f)).toMatchObject({ changes: 3, pages: 3 });
    expect(changesOnPage(f, 'n', 1)).toBe(1);
    expect(shownRegions(f, 'n', 3)).toEqual([]); // added page hidden
  });
});
