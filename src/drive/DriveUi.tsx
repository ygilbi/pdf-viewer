import { useEffect, useRef, useState } from 'react';
import { useFileQueue } from '../state/fileQueue';
import { formatBytes } from '../components/ui/util';
import { getDriveConfig, driveSupported } from './config';
import { isDriveOpenPath, parseDriveState } from './driveState';
import { openFromDrive, overallPercent, pickFromDrive, useDrive, type DeliverFiles } from './driveOpen';
import { loadPicker, loadScript, GIS_SRC } from './google';

/** Google Drive mark (three-colour triangle). */
export function DriveLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 87.3 78" aria-hidden="true">
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
      <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47" />
      <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335" />
      <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
      <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
      <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
    </svg>
  );
}

let launchHandled = false;

/**
 * Drive's Open URL (/drive/open?state=…): download the files Drive passed and open them. The URL is replaced
 * with "/" once handled, so a reload does not download again. Web only.
 */
export function useDriveLaunch(deliver: DeliverFiles): void {
  const ref = useRef(deliver);
  ref.current = deliver;
  useEffect(() => {
    if (launchHandled || !driveSupported() || !isDriveOpenPath(location.pathname)) return;
    launchHandled = true; // StrictMode runs effects twice
    const clearUrl = () => history.replaceState(history.state, '', `${import.meta.env.BASE_URL}`);
    const launch = parseDriveState(location.search);
    if (!launch || launch.action === 'create') {
      clearUrl(); // "New → PDF Viewer" (nothing to create) or a malformed state: just the app
      return;
    }
    void openFromDrive({ ids: launch.ids, resourceKeys: launch.resourceKeys, hint: launch.userId }, (f) => ref.current(f), clearUrl);
  }, []);
}

/** Progress card / "continue" prompt / error card for Drive downloads. */
export function DriveOverlay() {
  const { status, progress, message, retry, cancel } = useDrive();
  if (status === 'idle') return null;
  const pct = overallPercent(progress);
  return (
    <div className="absolute inset-0 z-[45] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" data-testid="drive-overlay" data-status={status}>
      <div role={status === 'error' ? 'alertdialog' : 'status'} aria-live="polite" className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-slate-700 bg-slate-800 px-6 py-6 text-center shadow-2xl">
        <DriveLogo size={34} />
        {status === 'loading' && (
          <>
            <div className="text-sm font-semibold">טוען מ-Google Drive…{pct != null && <span className="ms-1 font-mono" dir="ltr">{pct}%</span>}</div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700">
              <div
                className={'h-full rounded-full bg-sky-400 transition-[width] duration-200 ' + (pct == null ? 'w-1/3 animate-pulse' : '')}
                style={pct != null ? { width: `${pct}%` } : undefined}
              />
            </div>
            {progress && (
              <div className="text-xs text-slate-400">
                {progress.count > 1 && <span>קובץ {progress.current} מתוך {progress.count} · </span>}
                <span className="font-mono" dir="ltr">
                  {formatBytes(progress.loaded)}
                  {progress.total ? ` / ${formatBytes(progress.total)}` : ''}
                </span>
              </div>
            )}
          </>
        )}
        {status === 'needs_click' && (
          <>
            <div className="text-sm font-semibold">פתיחת קובץ מ-Google Drive</div>
            <div className="text-xs text-slate-400">כדי לטעון את הקובץ יש לאשר ל-PDF Viewer גישה לקבצים שנפתחים בו מ-Google Drive.</div>
            <div className="flex gap-2">
              <button type="button" onClick={() => retry?.()} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300" data-testid="drive-continue">
                המשך ל-Google Drive
              </button>
              <button type="button" onClick={cancel} className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:text-white">
                ביטול
              </button>
            </div>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="text-sm font-semibold text-red-300">לא ניתן לפתוח את הקובץ מ-Google Drive</div>
            <div className="text-xs text-slate-300" data-testid="drive-error">{message}</div>
            <div className="flex gap-2">
              {retry && (
                <button type="button" onClick={() => retry()} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500">
                  נסה שוב
                </button>
              )}
              <button type="button" onClick={cancel} className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:text-white">
                סגור
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** True once the Picker is configured (GOOGLE_API_KEY + GOOGLE_PROJECT_NUMBER) — preloads the Google scripts. */
function usePickerAvailable(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    void getDriveConfig().then((cfg) => {
      if (!alive || !cfg?.picker) return;
      setOk(true);
      // Preload so the click opens Google's popup within the user gesture.
      void loadScript(GIS_SRC).catch(() => {});
      void loadPicker().catch(() => {});
    });
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}

/** "Open from Google Drive" (Picker). Renders nothing when not configured or in the desktop app. */
export function DriveOpenButton({ variant = 'button', onBeforeOpen }: { variant?: 'button' | 'menu'; onBeforeOpen?(): void }) {
  const available = usePickerAvailable();
  const busy = useDrive((s) => s.status === 'loading');
  if (!available) return null;
  const onClick = () => {
    onBeforeOpen?.();
    void pickFromDrive((files) => useFileQueue.getState().addFiles(files));
  };
  if (variant === 'menu')
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        data-testid="drive-open-menu"
        className="flex h-8 items-center gap-1.5 rounded px-2 text-xs text-slate-200 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50"
      >
        <DriveLogo size={16} />
        <span>פתח מ-Google Drive</span>
      </button>
    );
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid="drive-open"
      className="flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-sky-500 hover:text-sky-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-60"
    >
      <DriveLogo size={18} />
      פתח מ-Google Drive
    </button>
  );
}
