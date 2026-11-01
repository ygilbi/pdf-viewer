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

/** Delivers every launched file (in order) via `onFiles`. `onFiles` may change identity freely. */
export function useFileLaunch(onFiles: (files: File[]) => void | Promise<void>): void {
  const ref = useRef(onFiles);
  ref.current = onFiles;
  useEffect(() => {
    const lq = typeof window !== 'undefined' ? window.launchQueue : undefined;
    if (!lq || typeof lq.setConsumer !== 'function') return;
    lq.setConsumer(async (params) => {
      const handles = (params?.files ?? []).filter((h) => h.kind === 'file') as FileSystemFileHandle[];
      if (!handles.length) return;
      const files: File[] = [];
      for (const h of handles) {
        try {
          files.push(await h.getFile());
        } catch (err) {
          console.error('[pwa] failed to read launched file', err);
        }
      }
      try {
        if (files.length) await ref.current(files);
      } catch (err) {
        console.error('[pwa] failed to open launched files', err);
      }
    });
    // launchQueue has no unsubscribe; the ref keeps the latest callback.
  }, []);
}
