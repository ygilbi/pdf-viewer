import { describe, expect, it } from 'vitest';
import { activeDocId, appendedDocIds, cycleDoc, pageForTab, pruneLastPages, rememberPage } from './docTabs';

const docs = [
  { id: 'a', numPages: 3, pageOffset: 0 },
  { id: 'b', numPages: 5, pageOffset: 3 },
  { id: 'c', numPages: 1, pageOffset: 8 },
];

describe('docTabs', () => {
  it('activeDocId maps a global page to its file', () => {
    expect(activeDocId(docs, 1)).toBe('a');
    expect(activeDocId(docs, 4)).toBe('b');
    expect(activeDocId(docs, 9)).toBe('c');
    expect(activeDocId(docs, 10)).toBeNull();
  });

  it('remembers the last local page per file and returns it for the tab', () => {
    let last = rememberPage({}, docs, 6); // b, local 3
    last = rememberPage(last, docs, 2); // a, local 2
    expect(last).toEqual({ b: 3, a: 2 });
    expect(rememberPage(last, docs, 2)).toBe(last); // unchanged → same object
    expect(pageForTab(last, docs[1])).toBe(6);
    expect(pageForTab(last, docs[0])).toBe(2);
    expect(pageForTab(last, docs[2])).toBe(9); // never visited → first page
  });

  it('clamps a remembered page that no longer exists', () => {
    expect(pageForTab({ b: 99 }, docs[1])).toBe(8);
  });

  it('prunes closed files', () => {
    const last = { a: 1, b: 2, z: 4 };
    expect(pruneLastPages(last, docs)).toEqual({ a: 1, b: 2 });
    const kept = { a: 1 };
    expect(pruneLastPages(kept, docs)).toBe(kept);
  });

  it('cycles tabs with wrap-around', () => {
    expect(cycleDoc(docs, 'a', 1)).toBe('b');
    expect(cycleDoc(docs, 'c', 1)).toBe('a');
    expect(cycleDoc(docs, 'a', -1)).toBe('c');
    expect(cycleDoc([], 'a', 1)).toBeNull();
  });

  it('appendedDocIds: only appends, not a replace or the first open', () => {
    expect(appendedDocIds([], [{ id: 'a' }])).toEqual([]);
    expect(appendedDocIds([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toEqual(['b']);
    expect(appendedDocIds([{ id: 'a' }], [{ id: 'x' }])).toEqual([]);
    expect(appendedDocIds([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }])).toEqual([]);
  });
});
