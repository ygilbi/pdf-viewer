import { useSyncExternalStore } from 'react';

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia !== 'function') return () => {};
      const mq = matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
    () => false,
  );
}

/** Below this width the phone layout is used even with a mouse. */
export const COMPACT_MAX_PX = 767;
export const COMPACT_QUERY = `(pointer: coarse), (max-width: ${COMPACT_MAX_PX}px)`;

/**
 * Phone / tablet layout: edit-mode tools as a bottom toolbar instead of the right palette,
 * and a slimmer pill (zoom / search / export live in ☰).
 */
export function useCompactLayout(): boolean {
  return useMedia(COMPACT_QUERY);
}
