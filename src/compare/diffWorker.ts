/// <reference lib="webworker" />
/**
 * Version-compare worker: runs the pixel work (core/versionDiff) off the main thread.
 * Diff:    { id, oldG, newG, w, h }                      → { id, diff }
 * Yellow:  { id, kind: 'yellow', oldG, newG, w, h, opts } → { id, yellow }  (rgba transferred)
 * Errors:  { id, error }
 */
import { diffPages, yellowOverlay, type YellowOptions } from '../core/versionDiff';

type Req = { id: number; kind?: 'diff' | 'yellow'; oldG: ArrayBuffer; newG: ArrayBuffer; w: number; h: number; opts?: YellowOptions };

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, kind, oldG, newG, w, h, opts } = e.data;
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    if (kind === 'yellow') {
      const yellow = yellowOverlay(new Uint8Array(oldG), new Uint8Array(newG), w, h, opts);
      post({ id, yellow }, [yellow.rgba.buffer as ArrayBuffer]);
    } else {
      post({ id, diff: diffPages(new Uint8Array(oldG), new Uint8Array(newG), w, h) });
    }
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
