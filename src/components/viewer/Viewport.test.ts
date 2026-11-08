import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewportController } from './Viewport';

/** Minimal stand-in for the world element (node test env, no DOM). */
function fakeWorld() {
  const props = new Map<string, string>();
  return {
    props,
    el: { style: { transform: '', setProperty: (k: string, v: string) => props.set(k, v) } } as unknown as HTMLElement,
  };
}

describe('ViewportController --dash-inv-zoom', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('follows --inv-zoom only after the zoom settles (not every pinch frame)', () => {
    vi.useFakeTimers();
    let raf: ((t: number) => void) | null = null;
    vi.stubGlobal('requestAnimationFrame', (fn: (t: number) => void) => ((raf = fn), 1));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('window', globalThis);
    const flush = () => {
      const fn = raf;
      raf = null;
      fn?.(performance.now());
    };
    const vp = new ViewportController();
    vp.setPageSize(1000, 1000);
    vp.setContainerSize(500, 500);
    const w = fakeWorld();
    vp.setWorld(w.el);
    flush();
    const z0 = String(1 / vp.zoom);
    expect(w.props.get('--dash-inv-zoom')).toBe(z0); // first frame: written at once

    for (let i = 0; i < 10; i++) {
      vp.zoomAt(1.2, 250, 250);
      flush();
      vi.advanceTimersByTime(16);
    }
    expect(w.props.get('--inv-zoom')).toBe(String(1 / vp.zoom));
    expect(w.props.get('--dash-inv-zoom')).toBe(z0); // unchanged during the gesture
    vi.advanceTimersByTime(200);
    expect(w.props.get('--dash-inv-zoom')).toBe(String(1 / vp.zoom));
    vp.destroy();
  });
});
