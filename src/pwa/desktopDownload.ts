/**
 * Link to the Windows desktop installer request page. Downloads are gated: the
 * visitor submits a request on /download, the owner approves it by email and the
 * requester receives a personal (expiring) download link. Never link the installer directly.
 */
export const WINDOWS_DOWNLOAD_URL = `${import.meta.env.BASE_URL}download`;

/** True on a Windows browser that is NOT already the desktop (Electron) app. */
export function showWindowsDownload(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if ((window as { pdfDesktop?: { isDesktop?: boolean } }).pdfDesktop?.isDesktop) return false;
  return /Windows/i.test(navigator.userAgent);
}
