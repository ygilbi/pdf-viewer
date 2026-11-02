/**
 * /download — just the logo, as large as the screen allows, and a way in:
 * the web app (no install) or the Windows installer (sign-in gated by /api/download).
 * Windows visitors get "הורד ל-Windows" as the primary action; everyone else "open in the browser".
 */
import { WordmarkLogo } from '../auth/Logo';
import { detectOs } from '../pwa/defaultApp';
import { WINDOWS_DOWNLOAD_URL } from '../pwa/desktopDownload';

const BASE = import.meta.env.BASE_URL;
const IS_WINDOWS = typeof navigator !== 'undefined' && detectOs(navigator as Parameters<typeof detectOs>[0]) === 'windows';

const PRIMARY =
  'flex w-full max-w-md items-center justify-center gap-3 rounded-xl bg-sky-500 px-5 py-3.5 text-center text-base [text-wrap:balance] font-semibold text-slate-950 shadow-lg shadow-sky-950/40 transition hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 sm:text-lg';
const SECONDARY =
  'rounded px-2 py-1 text-sm text-slate-400 underline decoration-slate-600 underline-offset-4 transition hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400';

export default function DownloadPage() {
  return (
    <main className="page-shell download-page" dir="rtl" data-os={IS_WINDOWS ? 'windows' : 'other'}>
      <div className="logo-stage">
        {/* Logo (mark + 2-line tagline, ~1.05:1) fits the free area in both dimensions, never scrolls. */}
        <WordmarkLogo className="logo-fit select-none" sizes="(min-aspect-ratio: 1/1) 80vh, 92vw" />
      </div>
      <nav className="flex w-full flex-col items-center gap-3 pt-[clamp(1rem,4vh,2.5rem)]" aria-label="כניסה">
        {IS_WINDOWS ? (
          <>
            <a href={WINDOWS_DOWNLOAD_URL} data-testid="download-windows" data-primary="true" className={PRIMARY}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0">
                <path d="M3 5.5 10.5 4.5v7H3zM11.5 4.4 21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.4z" />
              </svg>
              הורד ל-Windows
            </a>
            <a href={BASE} data-testid="open-web-app" className={SECONDARY}>
              או פתח בדפדפן — ללא התקנה
            </a>
          </>
        ) : (
          <>
            <a href={BASE} data-testid="open-web-app" data-primary="true" className={PRIMARY}>
              <span>
                פתח את PDF Viewer בדפדפן <span className="whitespace-nowrap">— ללא התקנה</span>
              </span>
            </a>
            <a href={WINDOWS_DOWNLOAD_URL} data-testid="download-windows" className={SECONDARY}>
              הורדה ל-Windows
            </a>
          </>
        )}
      </nav>
    </main>
  );
}
