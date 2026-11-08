/**
 * iOS Safari runs its own pinch recogniser (gesturestart / gesturechange / gestureend) next to
 * pointer events and ignores user-scalable=no. The viewer does its own zoom, so cancel Safari's:
 * it never page-zooms underneath the viewer (a crash report showed both running together).
 */
export function blockNativeZoom(target: Document = document): () => void {
  const stop = (e: Event) => e.preventDefault();
  const opts: AddEventListenerOptions = { passive: false };
  const names = ['gesturestart', 'gesturechange', 'gestureend'];
  for (const n of names) target.addEventListener(n, stop, opts);
  return () => {
    for (const n of names) target.removeEventListener(n, stop, opts);
  };
}
