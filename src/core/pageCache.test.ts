import { describe, expect, it } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PageCache } from './renderQueue';

function fakeDoc() {
  const cleaned: number[] = [];
  const doc = { getPage: (n: number) => Promise.resolve({ cleanup: () => (cleaned.push(n), true) }) } as unknown as PDFDocumentProxy;
  return { doc, cleaned };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PageCache operator budget', () => {
  it('keeps normal pages (count limit only)', async () => {
    const { doc, cleaned } = fakeDoc();
    const c = new PageCache(doc, 3, 1000);
    for (let p = 1; p <= 3; p++) {
      void c.get(p);
      c.noteOps(p, 100);
    }
    await tick();
    expect(cleaned).toEqual([]);
    void c.get(4);
    await tick();
    expect(cleaned).toEqual([1]);
  });
  it('evicts older pages when the cached operator lists exceed the budget, never the newest', async () => {
    const { doc, cleaned } = fakeDoc();
    const c = new PageCache(doc, 20, 1000);
    void c.get(1);
    c.noteOps(1, 700);
    void c.get(2);
    c.noteOps(2, 100);
    await tick();
    expect(cleaned).toEqual([]);
    void c.get(3);
    c.noteOps(3, 900); // 1700 > 1000 → drop LRU pages until within budget
    await tick();
    expect(cleaned).toEqual([1]);
    void c.get(4);
    c.noteOps(4, 2000); // alone over budget: the newest page is kept
    await tick();
    expect(cleaned).toEqual([1, 2, 3]);
  });
  it('transient renders (version compare) free their page afterwards, unless the viewer uses it', async () => {
    const { doc, cleaned } = fakeDoc();
    const c = new PageCache(doc, 20, 1000);
    void c.get(1); // viewer
    void c.get(1, true); // compare renders the page on screen
    c.releaseTransient(1);
    void c.get(2, true); // compare renders another page
    c.noteOps(2, 500);
    c.releaseTransient(2);
    await tick();
    expect(cleaned).toEqual([2]);
    void c.get(3, true);
    void c.get(3); // the viewer opened it meanwhile → keep
    c.releaseTransient(3);
    await tick();
    expect(cleaned).toEqual([2]);
  });
});
