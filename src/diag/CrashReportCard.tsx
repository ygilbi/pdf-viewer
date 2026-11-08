/**
 * Small card shown after a detected crash (or uncaught error) in the previous session, and
 * for the ☰ menu's manual "שלח דוח תקלה". Report = technical data only (see report.ts).
 */
import { useEffect } from 'react';
import { copyReport, dismissReport, sendReport, useDiagUi, watchPending } from './diagUi';

const TITLE: Record<string, string> = {
  crash: 'נראה שהאפליקציה נסגרה באופן לא צפוי. שליחת דוח תעזור לנו לתקן',
  error: 'בפעם הקודמת אירעה שגיאה באפליקציה. שליחת דוח תעזור לנו לתקן',
  manual: 'דוח תקלה',
};

const btn = 'h-8 rounded px-3 text-xs font-semibold focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 disabled:opacity-50';

export function CrashReportCard() {
  const kind = useDiagUi((s) => s.kind);
  const status = useDiagUi((s) => s.status);
  const copied = useDiagUi((s) => s.copied);

  useEffect(() => watchPending(), []);

  if (!kind) return null;
  const busy = status === 'sending';
  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="דוח תקלה"
      data-testid="crash-report-card"
      data-kind={kind}
      data-status={status}
      className="pointer-events-auto fixed bottom-4 left-1/2 z-[60] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-slate-600 bg-slate-800/95 p-3 text-sm text-slate-100 shadow-2xl backdrop-blur"
    >
      <div className="font-semibold leading-snug">{TITLE[kind]}</div>
      <div className="mt-1 text-xs text-slate-400">
        הדוח מכיל נתונים טכניים בלבד (סוג מכשיר, פעולות אחרונות ושגיאות) — ללא תוכן או שמות של קבצים וללא טקסט של מדידות.
      </div>
      {status === 'sending' && <div className="mt-2 text-xs text-sky-300">שולח דוח…</div>}
      {status === 'sent' && <div className="mt-2 text-xs text-emerald-300">הדוח נשלח. תודה!</div>}
      {status === 'failed' && <div className="mt-2 text-xs text-red-300">שליחת הדוח נכשלה. אפשר להעתיק אותו ולשלוח ידנית.</div>}
      {copied && <div className="mt-2 text-xs text-emerald-300">הדוח הועתק ללוח.</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {status !== 'sent' && (
          <button type="button" data-testid="crash-report-send" disabled={busy} onClick={() => void sendReport()} className={`${btn} bg-sky-600 text-white hover:bg-sky-500`}>
            {status === 'failed' ? 'נסה שוב' : 'שלח דוח'}
          </button>
        )}
        <button type="button" data-testid="crash-report-copy" disabled={busy} onClick={() => void copyReport()} className={`${btn} border border-slate-600 text-slate-200 hover:bg-slate-700`}>
          העתק דוח
        </button>
        <div className="flex-1" />
        <button type="button" data-testid="crash-report-dismiss" onClick={dismissReport} className={`${btn} text-slate-400 hover:bg-slate-700 hover:text-white`}>
          {status === 'sent' || kind === 'manual' ? 'סגור' : 'לא עכשיו'}
        </button>
      </div>
    </div>
  );
}
