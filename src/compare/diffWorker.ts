/// <reference lib="webworker" />
/**
 * Version-compare worker: runs the pixel diff (core/versionDiff) off the main thread.
 * Request:  { id, oldG, newG, w, h }  (gray buffers, transferred)
 * Response: { id, diff } | { id, error }
 */
import { diffPages } from '../core/versionDiff';

self.onmessage = (e: MessageEvent<{ id: number; oldG: ArrayBuffer; newG: ArrayBuffer; w: number; h: number }>) => {
  const { id, oldG, newG, w, h } = e.data;
  try {
    const diff = diffPages(new Uint8Array(oldG), new Uint8Array(newG), w, h);
    (self as unknown as Worker).postMessage({ id, diff });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
