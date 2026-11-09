import { useSyncExternalStore } from 'react';

/**
 * "The current page has been drawn" signal, read from the TileLayer's performance marks
 * (`viewer:setPage` → a page is about to be drawn, `viewer:base` → its first raster is on screen).
 * Used to keep non-essential work (auto scale detection, lazy chrome chunks) off the critical
 * path of opening a file: it starts once the drawing is visible and the browser is idle.
 */

let painted = false;
/** Became true at least once this session (first page of the first file drawn). */
let everPainted = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let observing = false;

function observe() {
  if (observing || typeof PerformanceObserver === 'undefined') return;
  observing = true;
  try {
    const po = new PerformanceObserver((list) => {
      let changed = false;
      for (const e of list.getEntries()) {
        if (e.name === 'viewer:setPage' && painted) {
          painted = false;
          changed = true;
        } else if (e.name === 'viewer:base' && !painted) {
          painted = true;
          everPainted = true;
          changed = true;
        }
      }
      if (changed) emit();
    });
    po.observe({ type: 'mark', buffered: true });
  } catch {
    // No mark observation (very old engines): behave as if drawn, i.e. no deferral.
    painted = everPainted = true;
  }
}

function subscribe(cb: () => void) {
  observe();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True once the current page's first raster is on screen (false again while a new page loads). */
export function usePagePainted(): boolean {
  return useSyncExternalStore(subscribe, () => painted, () => false);
}

type IdleWin = Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };

/** Runs `cb` when the browser is idle (Safari has no requestIdleCallback: short timeout instead). */
export function onIdle(cb: () => void, timeout = 1500): () => void {
  const w = window as IdleWin;
  if (w.requestIdleCallback) {
    const h = w.requestIdleCallback(cb, { timeout });
    return () => w.cancelIdleCallback?.(h);
  }
  const h = window.setTimeout(cb, 200);
  return () => window.clearTimeout(h);
}

/** Runs `cb` once, at idle time after the first page of the session has been drawn. */
export function afterFirstPaint(cb: () => void): () => void {
  let cancelIdle: (() => void) | null = null;
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    unsub();
    cancelIdle = onIdle(cb);
  };
  const unsub = subscribe(() => everPainted && fire());
  if (everPainted) fire();
  return () => {
    done = true;
    unsub();
    cancelIdle?.();
  };
}

/** Hook form of afterFirstPaint: false until the first page was drawn and the browser went idle. */
export function useAfterFirstPaint(): boolean {
  return useSyncExternalStore(subscribeIdle, () => idleReady, () => false);
}

let idleReady = false;
let idleArmed = false;
const idleListeners = new Set<() => void>();
function subscribeIdle(cb: () => void) {
  idleListeners.add(cb);
  if (!idleArmed) {
    idleArmed = true;
    afterFirstPaint(() => {
      idleReady = true;
      idleListeners.forEach((l) => l());
    });
  }
  return () => idleListeners.delete(cb);
}
