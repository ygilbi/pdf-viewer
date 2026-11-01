/**
 * Tiny imperative bridge between the viewer (which owns the view transform in
 * refs, outside React) and anything else that wants to drive it — e.g. the
 * toolbar's zoom buttons and zoom readout.
 *
 *   viewerCommands.fit()        fit the current page into the viewport (animated)
 *   viewerCommands.zoomIn()     zoom in  ×1.5 around the viewport centre (animated)
 *   viewerCommands.zoomOut()    zoom out ÷1.5 around the viewport centre (animated)
 *   viewerCommands.zoomTo(pct)  set zoom in percent (100 = 1 CSS px per PDF point)
 *   viewerCommands.getZoom()    current zoom in percent (100 = 1 CSS px per PDF point)
 *   viewerCommands.getZoomInfo() full info (raw scale, fit scale, limits)
 *
 *   subscribeZoom(cb)           cb(percent, info) on every zoom change (≤ once per
 *                               animation frame). Called once immediately with the
 *                               current value. Returns an unsubscribe function.
 *   useZoom()                   React hook over the same data.
 *
 * All calls are safe no-ops while no viewer is mounted.
 */
import { useSyncExternalStore } from 'react';

export interface ViewerZoomInfo {
  /** Zoom in percent: 100 = 1 CSS px per PDF page unit (point). */
  percent: number;
  /** Raw zoom: CSS px per page unit. */
  scale: number;
  /** Raw zoom that fits the current page into the viewport. */
  fitScale: number;
  minScale: number;
  maxScale: number;
}

/** Implemented by the mounted ViewerCanvas. */
export interface ViewerImpl {
  fit(): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Raw scale (CSS px per page unit), anchored at viewport centre. */
  zoomToScale(scale: number): void;
}

let impl: ViewerImpl | null = null;
let info: ViewerZoomInfo = { percent: 100, scale: 1, fitScale: 1, minScale: 0.25, maxScale: 64 };
const subscribers = new Set<(percent: number, info: ViewerZoomInfo) => void>();

export const viewerCommands = {
  fit: (): void => impl?.fit(),
  zoomIn: (): void => impl?.zoomIn(),
  zoomOut: (): void => impl?.zoomOut(),
  zoomTo: (percent: number): void => {
    if (Number.isFinite(percent) && percent > 0) impl?.zoomToScale(percent / 100);
  },
  getZoom: (): number => info.percent,
  getZoomInfo: (): ViewerZoomInfo => info,
};

export function subscribeZoom(cb: (percent: number, info: ViewerZoomInfo) => void): () => void {
  subscribers.add(cb);
  cb(info.percent, info);
  return () => {
    subscribers.delete(cb);
  };
}

export function useZoom(): ViewerZoomInfo {
  return useSyncExternalStore(
    (onChange) => subscribeZoom(() => onChange()),
    () => info,
  );
}

// ---- internal (used by ViewerCanvas only) ----------------------------------

export function registerViewer(next: ViewerImpl | null): void {
  impl = next;
}

export function emitZoom(scale: number, fitScale: number, minScale: number, maxScale: number): void {
  if (
    scale === info.scale &&
    fitScale === info.fitScale &&
    minScale === info.minScale &&
    maxScale === info.maxScale
  ) {
    return;
  }
  info = { percent: scale * 100, scale, fitScale, minScale, maxScale };
  for (const cb of subscribers) cb(info.percent, info);
}
