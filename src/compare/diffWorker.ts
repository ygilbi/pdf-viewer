/// <reference lib="webworker" />
/**
 * Version-compare worker: runs the pixel diff (core/versionDiff) off the main thread.
 * Request:  { id, oldG, newG, w, h, withOverlay? }  (gray buffers, transferred)
 * Response: { id, diff } | { id, error }   (diff.overlay transferred back)
 */
import { diffPages } from '../core/versionDiff';

self.onmessage = (e: MessageEvent<{ id: number; oldG: ArrayBuffer; newG: ArrayBuffer; w: number; h: number; withOverlay?: boolean }>) => {
  const { id, oldG, newG, w, h, withOverlay } = e.data;
  try {
    const diff = diffPages(new Uint8Array(oldG), new Uint8Array(newG), w, h, { withOverlay });
    const transfer = diff.overlay ? [diff.overlay.buffer as ArrayBuffer] : [];
    (self as unknown as Worker).postMessage({ id, diff }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
