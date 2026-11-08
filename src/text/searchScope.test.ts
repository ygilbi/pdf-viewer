import { describe, expect, it } from 'vitest';
import { docsWithoutText, groupResultsByDoc, pagesForScope } from './searchScope';

const docs = [
  { id: 'a', name: 'A.pdf', numPages: 3, pageOffset: 0 },
  { id: 'b', name: 'B.pdf', numPages: 4, pageOffset: 3 },
];

describe('pagesForScope', () => {
  it('page / current file / all files, current page first', () => {
    expect(pagesForScope('page', docs, 5, 7)).toEqual([5]);
    expect(pagesForScope('doc', docs, 5, 7)).toEqual([5, 4, 6, 7]);
    expect(pagesForScope('doc', docs, 1, 7)).toEqual([1, 2, 3]);
    expect(pagesForScope('all', docs, 5, 7)).toEqual([5, 1, 2, 3, 4, 6, 7]);
    expect(pagesForScope('all', docs, 1, 0)).toEqual([]);
  });
});

describe('groupResultsByDoc', () => {
  it('groups file → page with local page numbers and flat indices', () => {
    const r = [{ page: 1 }, { page: 1 }, { page: 3 }, { page: 4 }, { page: 7 }, { page: 7 }];
    const g = groupResultsByDoc(r, docs);
    expect(g.map((x) => [x.doc?.name, x.count])).toEqual([
      ['A.pdf', 3],
      ['B.pdf', 3],
    ]);
    expect(g[0].pages.map((p) => [p.page, p.localPage, p.items.map((i) => i.i)])).toEqual([
      [1, 1, [0, 1]],
      [3, 3, [2]],
    ]);
    expect(g[1].pages.map((p) => [p.page, p.localPage, p.items.map((i) => i.i)])).toEqual([
      [4, 1, [3]],
      [7, 4, [4, 5]],
    ]);
  });

  it('empty results → no groups', () => {
    expect(groupResultsByDoc([], docs)).toEqual([]);
  });
});

describe('docsWithoutText', () => {
  it('flags a fully scanned file with no text runs only', () => {
    const scanned = new Set([1, 2, 3, 4, 5, 6, 7]);
    expect(docsWithoutText(docs, scanned, new Set([2])).map((d) => d.id)).toEqual(['b']);
    expect(docsWithoutText(docs, new Set([1, 2]), new Set()).map((d) => d.id)).toEqual([]); // partially scanned
  });
});
