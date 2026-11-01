/** Link to the Windows desktop installer (GitHub Releases, built by .github/workflows/desktop-windows.yml). */
export const WINDOWS_DOWNLOAD_URL = 'https://github.com/ygilbi/pdf-viewer/releases/latest';

/** True on a Windows browser that is NOT already the desktop (Electron) app. */
export function showWindowsDownload(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if ((window as { pdfDesktop?: { isDesktop?: boolean } }).pdfDesktop?.isDesktop) return false;
  return /Windows/i.test(navigator.userAgent);
}
