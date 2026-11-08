import { beforeEach, describe, expect, it } from 'vitest';
import { useViewer } from './store';
import { followLink, goBackLink, reconcileHops, useLinkHistory } from './linkHistory';

describe('link back trail', () => {
  beforeEach(() => {
    useViewer.setState({ numPages: 10, currentPage: 1 });
    useLinkHistory.getState().clear();
  });
  it('follows a chain and goes back step by step', () => {
    followLink(4, 'A1');
    followLink(7, 'B2');
    expect(useViewer.getState().currentPage).toBe(7);
    expect(goBackLink()).toBe(true);
    expect(useViewer.getState().currentPage).toBe(4);
    expect(goBackLink()).toBe(true);
    expect(useViewer.getState().currentPage).toBe(1);
    expect(goBackLink()).toBe(false);
  });
  it('forgets the trail when leaving the target page another way', () => {
    const hops = [{ from: 1, to: 4 }];
    expect(reconcileHops(hops, 4)).toBe(hops);
    expect(reconcileHops(hops, 5)).toEqual([]);
  });
  it('ignores links to the current page', () => {
    followLink(1);
    expect(useLinkHistory.getState().hops).toEqual([]);
  });
});
