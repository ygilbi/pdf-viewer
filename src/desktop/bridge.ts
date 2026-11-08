/**
 * Bridge to the Windows desktop shell (Electron, desktop/preload.cjs).
 * In the browser / PWA `window.pdfDesktop` is undefined and every helper here is a no-op.
 */
import { useEffect, useRef } from 'react';

export interface DesktopOpenedFile {
  name: string;
  bytes: ArrayBuffer;
}

export interface PdfDesktopApi {
  readonly isDesktop: true;
  /** Desktop app version (desktop/package.json). */
  readonly version: string;
  readonly platform?: string;
  /** PDFs opened from Explorer / "Open with" / the command line. Returns unsubscribe. */
  onOpenFiles(cb: (files: DesktopOpenedFile[]) => void): () => void;
  /** Settings › Apps › Default apps › PDF Viewer (Windows 10/11). */
  openDefaultAppsSettings(): Promise<void>;
  /** The user's .pdf choice is PDF Viewer (true), another app (false), or unknown (null). */
  isDefaultPdfApp(): Promise<boolean | null>;
  /**
   * Persistent preferences in the desktop app's userData/prefs.json (survive cleared
   * site data). Allow-listed keys only (main.cjs PREF_KEYS); null when unset.
   * Optional: absent in desktop builds older than 0.2.0.
   */
  getPref?(key: DesktopPrefKey): Promise<unknown>;
  setPref?(key: DesktopPrefKey, value: unknown): Promise<void>;
  /**
   * Web-content updates (desktop/updater.cjs). Optional: absent before 0.3.0.
   * checkForUpdates downloads a new build right away when there is one.
   */
  checkForUpdates?(): Promise<DesktopUpdateResult>;
  /** Reloads the window onto the downloaded build. */
  applyUpdate?(): Promise<boolean>;
  getUpdateState?(): Promise<DesktopUpdateState>;
  /** A new build was downloaded and is ready (applyUpdate, or the next launch, uses it). Returns unsubscribe. */
  onUpdateReady?(cb: (state: DesktopUpdateState) => void): () => void;
}

export interface DesktopUpdateState {
  /** Build being served. */
  active: string | null;
  /** Downloaded build waiting for a reload / restart, or null. */
  pending: string | null;
  /** ms epoch of the last successful check, or null. */
  lastCheck: number | null;
}

export interface DesktopUpdateResult {
  status: 'up-to-date' | 'downloaded' | 'pending' | 'incompatible' | 'busy' | 'error';
  buildId?: string;
  /** status 'incompatible': page with the new installer. */
  downloadUrl?: string;
  error?: string;
}

/** Keys accepted by getPref / setPref (keep in sync with PREF_KEYS in desktop/main.cjs). */
export type DesktopPrefKey = 'defaultPdfPrompt';

declare global {
  interface Window {
    readonly pdfDesktop?: PdfDesktopApi;
  }
}

export function getDesktop(): PdfDesktopApi | null {
  if (typeof window === 'undefined') return null;
  const d = window.pdfDesktop;
  return d && d.isDesktop === true ? d : null;
}

export const isDesktopApp = (): boolean => getDesktop() !== null;

/** Wraps the bytes the desktop shell read from disk as File objects. */
export function toFiles(files: readonly DesktopOpenedFile[]): File[] {
  return files.map((f) => new File([f.bytes], f.name, { type: 'application/pdf' }));
}

/** Delivers PDFs opened through the desktop shell via `onFiles` (desktop counterpart of useFileLaunch). */
export function useDesktopFileOpen(onFiles: (files: File[]) => void | Promise<void>): void {
  const ref = useRef(onFiles);
  ref.current = onFiles;
  useEffect(() => {
    const d = getDesktop();
    if (!d) return;
    return d.onOpenFiles((files) => {
      if (!files.length) return;
      try {
        void ref.current(toFiles(files));
      } catch (err) {
        console.error('[desktop] failed to open files', err);
      }
    });
  }, []);
}
