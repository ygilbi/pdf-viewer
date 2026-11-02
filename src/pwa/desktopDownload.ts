/**
 * Windows desktop installer link. Downloads are gated by sign-in: `/api/download`
 * redirects a signed-in user to the installer and everyone else to
 * /login?next=/api/download (passkey sign-in, or "request access" for new users).
 * Never link the installer file directly.
 */
export const WINDOWS_DOWNLOAD_URL = `${import.meta.env.BASE_URL}api/download`;

/** True on a Windows browser that is NOT already the desktop (Electron) app. */
export function showWindowsDownload(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if ((window as { pdfDesktop?: { isDesktop?: boolean } }).pdfDesktop?.isDesktop) return false;
  return /Windows/i.test(navigator.userAgent);
}
