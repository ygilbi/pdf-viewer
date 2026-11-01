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
}

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
