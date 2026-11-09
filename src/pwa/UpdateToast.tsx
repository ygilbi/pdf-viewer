/**
 * "A new version is installed" toast + the automatic switch to it (see updates.ts).
 *
 * Automatic reload only when nothing can be lost: no PDF open (a reload closes the
 * open files — their measurements are auto-saved, the PDF itself is not), nothing
 * loading, no pointer pressed / shape being drawn. It happens when the window is
 * hidden (user away) or becomes visible again, at most once per AUTO_RELOAD_GUARD_MS.
 * With a document open the toast offers "רענן עכשיו" / "הפעל מחדש עכשיו" instead.
 *
 * Also renders the transient results of a manual "בדוק עדכונים" (UpdateCheckButton).
 */
import { useEffect } from 'react';
import { useViewer } from '../state/store';
import { useFileQueue } from '../state/fileQueue';
import { getDesktop } from '../desktop/bridge';
import { applyUpdate, checkForUpdatesNow, initDesktopUpdates, recentlyAutoReloaded, useUpdates } from './updates';

let pointersDown = 0;
let pointerTracking = false;
function trackPointers() {
  if (pointerTracking) return;
  pointerTracking = true;
  const down = () => {
    pointersDown++;
  };
  const up = () => {
    pointersDown = Math.max(0, pointersDown - 1);
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', () => {
    pointersDown = 0;
  });
}

/** Nothing would be lost by reloading now. */
export function isIdleForReload(): boolean {
  const v = useViewer.getState();
  return v.numPages === 0 && v.docs.length === 0 && !v.loading && v.draft.length === 0 && useFileQueue.getState().items.length === 0 && pointersDown === 0;
}

const TRANSIENT_MS: Partial<Record<string, number>> = { 'up-to-date': 5000, error: 8000, incompatible: 20000 };

export function UpdateToast() {
  const status = useUpdates((s) => s.status);
  const kind = useUpdates((s) => s.kind);
  const manual = useUpdates((s) => s.manual);
  const downloadUrl = useUpdates((s) => s.downloadUrl);
  const hasDoc = useViewer((s) => s.numPages > 0);

  useEffect(() => {
    trackPointers();
    initDesktopUpdates();
  }, []);

  // Automatic switch while idle.
  useEffect(() => {
    if (status !== 'ready') return;
    const tryAuto = () => {
      if (!isIdleForReload() || recentlyAutoReloaded()) return;
      void applyUpdate(true);
    };
    // Nothing open (start screen, e.g. right after a crash/relaunch): switch right away, so a fix
    // reaches the device without the user having to find the toast. Otherwise wait until hidden.
    if (document.visibilityState === 'hidden' || isIdleForReload()) tryAuto();
    document.addEventListener('visibilitychange', tryAuto);
    return () => document.removeEventListener('visibilitychange', tryAuto);
  }, [status]);

  // Transient manual-check results disappear by themselves.
  useEffect(() => {
    const ms = TRANSIENT_MS[status];
    if (!ms || !manual) return;
    const t = window.setTimeout(() => useUpdates.setState({ status: 'idle', manual: false }), ms);
    return () => window.clearTimeout(t);
  }, [status, manual]);

  const dismissed = useUpdates((s) => s.dismissed);
  // × hides a ready update (it still applies automatically / on the next launch); other results go away.
  const close = () => useUpdates.setState(status === 'ready' ? { dismissed: true, manual: false } : { status: 'idle', manual: false });

  if (status === 'idle' || (status === 'ready' && dismissed && !manual)) return null;
  if (status !== 'ready' && !manual) return null;

  const desktop = kind === 'desktop';
  let text: string;
  let tone = 'border-slate-600 bg-slate-800/95 text-slate-100';
  let action: { label: string; onClick: () => void } | null = null;
  let sub: string | null = null;
  switch (status) {
    case 'ready':
      text = desktop ? 'גרסה חדשה של התוכנה הורדה' : 'גרסה חדשה של התוכנה הותקנה';
      tone = 'border-sky-700 bg-sky-950/95 text-sky-50';
      action = { label: desktop ? 'הפעל מחדש עכשיו' : 'רענן עכשיו', onClick: () => void applyUpdate(false) };
      if (hasDoc) sub = 'הקבצים הפתוחים ייסגרו — המדידות נשמרות ויחזרו כשתפתח אותם שוב';
      break;
    case 'checking':
      text = 'בודק עדכונים…';
      break;
    case 'downloading':
      text = 'מוריד עדכון…';
      break;
    case 'up-to-date':
      text = 'התוכנה מעודכנת לגרסה האחרונה';
      tone = 'border-emerald-700 bg-emerald-950/95 text-emerald-100';
      break;
    case 'incompatible':
      text = 'יש גרסה חדשה שדורשת התקנה מחדש של התוכנה';
      tone = 'border-amber-700 bg-amber-950/95 text-amber-50';
      if (downloadUrl) action = { label: 'להורדה', onClick: () => window.open(downloadUrl, '_blank', 'noopener') };
      break;
    default:
      text = 'בדיקת העדכונים נכשלה — נסה שוב מאוחר יותר';
      tone = 'border-red-800 bg-red-950/95 text-red-100';
  }

  return (
    <div
      role="status"
      dir="rtl"
      data-testid="update-toast"
      data-status={status}
      className={`pointer-events-auto absolute bottom-4 left-4 z-[65] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-md border px-3 py-2 text-sm shadow-xl backdrop-blur ${tone}`}
    >
      {(status === 'checking' || status === 'downloading') && (
        <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-500 border-t-sky-400" />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium">{text}</div>
        {sub && <div className="mt-0.5 text-xs opacity-75">{sub}</div>}
      </div>
      {action && (
        <button
          type="button"
          data-testid="update-apply"
          onClick={action.onClick}
          className="shrink-0 rounded bg-sky-600 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        onClick={close}
        aria-label="סגור הודעה"
        className="shrink-0 rounded px-1 opacity-70 hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

/** Small "בדוק עדכונים" link (empty-state screen); shows the desktop version when there is one. */
export function UpdateCheckButton({ className = '' }: { className?: string }) {
  const status = useUpdates((s) => s.status);
  const busy = status === 'checking' || status === 'downloading';
  const version = getDesktop()?.version;
  return (
    <div className={`flex items-center gap-2 text-xs text-slate-500 ${className}`}>
      {version && (
        <span dir="ltr" className="font-mono">
          v{version}
        </span>
      )}
      <button
        type="button"
        data-testid="update-check"
        disabled={busy}
        onClick={() => void checkForUpdatesNow()}
        className="rounded px-1 underline-offset-2 hover:text-slate-300 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? 'בודק עדכונים…' : 'בדוק עדכונים'}
      </button>
    </div>
  );
}
