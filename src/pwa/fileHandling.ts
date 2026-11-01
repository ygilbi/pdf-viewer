/**
 * File Handling API (PWA "Open with…" / default PDF app).
 * When the installed app is launched with a file (double-click a .pdf after the
 * app was set as default), Chromium delivers FileSystemFileHandles through
 * `window.launchQueue`. Launches are buffered until a consumer is set, so it is
 * safe to subscribe after the first render. No-op in unsupported browsers.
 */
import { useEffect, useRef } from 'react';
import { COLD_START_WINDOW_MS } from './defaultApp';

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

export interface FileLaunchInfo {
  /** Number of file handles delivered. */
  count: number;
  /** First launch of this page, shortly after navigation start: the file opened the window. */
  cold: boolean;
}
const launchListeners = new Set<(info: FileLaunchInfo) => void>();
let launchesSeen = 0;
let lastLaunch: FileLaunchInfo | null = null;
/** Subscribe to launches that carried files (default-app onboarding). Returns unsubscribe. */
export function onFileLaunch(listener: (info: FileLaunchInfo) => void): () => void {
  launchListeners.add(listener);
  return () => launchListeners.delete(listener);
}
/** The most recent launch with files in this page, if any. */
export const lastFileLaunch = (): FileLaunchInfo | null => lastLaunch;
function notifyLaunch(count: number) {
  const cold = launchesSeen++ === 0 && typeof performance !== 'undefined' && performance.now() < COLD_START_WINDOW_MS;
  if (!count) return; // plain launch (no files) still marks later ones as warm
  lastLaunch = { count, cold };
  launchListeners.forEach((l) => {
    try {
      l(lastLaunch!);
    } catch (err) {
      console.error('[pwa] launch listener failed', err);
    }
  });
}

/** Delivers every launched file (in order) via `onFiles`. `onFiles` may change identity freely. */
export function useFileLaunch(onFiles: (files: File[]) => void | Promise<void>): void {
  const ref = useRef(onFiles);
  ref.current = onFiles;
  useEffect(() => {
    const lq = typeof window !== 'undefined' ? window.launchQueue : undefined;
    if (!lq || typeof lq.setConsumer !== 'function') return;
    lq.setConsumer(async (params) => {
      const handles = (params?.files ?? []).filter((h) => h.kind === 'file') as FileSystemFileHandle[];
      notifyLaunch(handles.length);
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
