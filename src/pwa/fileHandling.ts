/**
 * File Handling API (PWA "Open with…" / default PDF app).
 * When the installed app is launched with a file (double-click a .pdf after the
 * app was set as default), Chromium delivers FileSystemFileHandles through
 * `window.launchQueue`. Launches are buffered until a consumer is set, so it is
 * safe to subscribe after the first render. No-op in unsupported browsers.
 */
import { useEffect, useRef } from 'react';

export interface LaunchParams {
  readonly targetURL?: string;
  readonly files: readonly FileSystemHandle[];
}
export interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => unknown): void;
}
declare global {
  interface Window {
    readonly launchQueue?: LaunchQueue;
  }
}

export const isFileHandlingSupported = (): boolean => typeof window !== 'undefined' && 'launchQueue' in window;

/** Opens the first launched PDF via `onFile`. `onFile` may change identity freely. */
export function useFileLaunch(onFile: (file: File) => void | Promise<void>): void {
  const ref = useRef(onFile);
  ref.current = onFile;
  useEffect(() => {
    const lq = typeof window !== 'undefined' ? window.launchQueue : undefined;
    if (!lq || typeof lq.setConsumer !== 'function') return;
    lq.setConsumer(async (params) => {
      const handle = params?.files?.[0];
      if (!handle || handle.kind !== 'file') return;
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        await ref.current(file);
      } catch (err) {
        console.error('[pwa] failed to open launched file', err);
      }
    });
    // launchQueue has no unsubscribe; the ref keeps the latest callback.
  }, []);
}
