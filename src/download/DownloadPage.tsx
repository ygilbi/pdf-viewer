/**
 * /download — just the logo, as large as the screen allows, and a way in:
 * the web app (no install) or the Windows installer (sign-in gated by /api/download).
 */
import { WordmarkLogo } from '../auth/Logo';

const BASE = import.meta.env.BASE_URL;

export default function DownloadPage() {
  return (
    <main className="page-shell download-page" dir="rtl">
      <div className="logo-stage">
        {/* Logo aspect 560:433 — fits the free area in both dimensions, never scrolls. */}
        <WordmarkLogo className="logo-fit select-none" sizes="(min-aspect-ratio: 1/1) 80vh, 92vw" />
      </div>
      <nav className="flex w-full flex-col items-center gap-3 pt-[clamp(1rem,4vh,2.5rem)]" aria-label="כניסה">
        <a
          href={BASE}
          data-testid="open-web-app"
          className="w-full max-w-md rounded-xl bg-sky-500 px-5 py-3.5 text-center text-base [text-wrap:balance] font-semibold text-slate-950 shadow-lg shadow-sky-950/40 transition hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 sm:text-lg"
        >
          פתח את PDF Viewer בדפדפן <span className="whitespace-nowrap">— ללא התקנה</span>
        </a>
        <a
          href={`${BASE}api/download`}
          data-testid="download-windows"
          className="rounded px-2 py-1 text-sm text-slate-400 underline decoration-slate-600 underline-offset-4 transition hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
        >
          הורדה ל-Windows
        </a>
      </nav>
    </main>
  );
}
