/**
 * "Set PDF Viewer as the default PDF app" onboarding.
 *
 * - Installed app window (standalone / WCO) on Windows or macOS: the modal opens
 *   automatically on launch until the user picks "done" / "never", or until we
 *   have seen enough cold launches via a PDF to assume we are the default.
 *   "Remind me later" (and Esc / ×) postpones it by a day.
 * - A launch that came from opening a PDF never shows it (probably already default).
 * - Browser tab: after `appinstalled`, a toast says to open the installed app.
 * - `openDefaultAppDialog()` opens it on demand (TopMenu entry).
 *
 * No app can make itself the default programmatically; this only guides the user.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import {
  WINDOWS_DEFAULT_APPS_URI,
  applyChoice,
  detectOs,
  isStandalone,
  loadState,
  recordFileLaunch,
  saveState,
  shouldAutoPrompt,
  type Os,
  type PromptChoice,
} from './defaultApp';
import { lastFileLaunch, onFileLaunch } from './fileHandling';
import { useInstallPrompt } from './installPrompt';

/** Grace period for launchQueue to deliver files before deciding to auto-prompt. */
const AUTO_PROMPT_DELAY_MS = 1200;
const TOAST_MS = 15_000;

interface DefaultAppUi {
  open: boolean;
  /** Opened automatically (vs. from the menu). */
  auto: boolean;
  installedToast: boolean;
}
const useDefaultAppUi = create<DefaultAppUi>(() => ({ open: false, auto: false, installedToast: false }));

export function openDefaultAppDialog(): void {
  useDefaultAppUi.setState({ open: true, auto: false });
}

/** OS of this device (stable for the session). */
export function currentOs(): Os {
  return typeof navigator === 'undefined' ? 'other' : detectOs(navigator as Parameters<typeof detectOs>[0]);
}

const BASE = import.meta.env.BASE_URL;

/** Mount once (App). Runs the auto-prompt logic and renders the modal + install toast. */
export function DefaultAppPrompt() {
  const open = useDefaultAppUi((s) => s.open);
  const toast = useDefaultAppUi((s) => s.installedToast);

  useEffect(() => {
    const os = currentOs();
    const standalone = isStandalone(window);
    const off = onFileLaunch(({ cold }) => {
      saveState(recordFileLaunch(loadState(), cold));
      // A PDF arrived while we were about to ask (or asking automatically): back off.
      if (useDefaultAppUi.getState().auto) useDefaultAppUi.setState({ open: false, auto: false });
    });
    const timer = window.setTimeout(() => {
      const ctx = { os, standalone, launchedWithFile: lastFileLaunch() !== null, state: loadState(), now: Date.now() };
      if (shouldAutoPrompt(ctx) && !useDefaultAppUi.getState().open) useDefaultAppUi.setState({ open: true, auto: true });
    }, AUTO_PROMPT_DELAY_MS);
    const onInstalled = () => {
      if (!isStandalone(window)) useDefaultAppUi.setState({ installedToast: true });
    };
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      off();
      window.clearTimeout(timer);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => useDefaultAppUi.setState({ installedToast: false }), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  return (
    <>
      {open && <DefaultAppDialog />}
      {toast && (
        <div
          role="status"
          data-testid="installed-toast"
          className="absolute bottom-6 left-1/2 z-[60] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-md border border-emerald-700 bg-emerald-950/95 px-3 py-2 text-sm text-emerald-100 shadow-xl backdrop-blur"
        >
          <span aria-hidden="true">✓</span>
          <span className="flex-1">האפליקציה הותקנה — פתח אותה מתפריט התחל כדי להגדיר כברירת מחדל</span>
          <button
            type="button"
            onClick={() => useDefaultAppUi.setState({ installedToast: false })}
            aria-label="סגור הודעה"
            className="rounded px-1 text-emerald-300 hover:bg-emerald-900 hover:text-white"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

function choose(choice: PromptChoice) {
  saveState(applyChoice(loadState(), choice, Date.now()));
  useDefaultAppUi.setState({ open: false, auto: false });
}

function DefaultAppDialog() {
  const os = currentOs();
  const [standalone] = useState(() => isStandalone(window));
  const [settingsOpened, setSettingsOpened] = useState(false);
  const primary = useRef<HTMLElement | null>(null);
  const setPrimary = (el: HTMLElement | null) => {
    primary.current = el;
  };

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    primary.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        choose('later');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.({ preventScroll: true });
    };
  }, []);

  const osLabel = os === 'mac' ? 'macOS' : os === 'windows' ? 'Windows' : 'מערכת ההפעלה';

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm" dir="rtl">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="default-app-title"
        data-testid="default-app-dialog"
        data-os={os}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-800 text-slate-100 shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-slate-700 px-5 py-4">
          <img src={`${BASE}icons/file-pdf-256.png`} alt="" width={44} height={44} className="h-11 w-11 shrink-0 object-contain" />
          <div className="min-w-0 flex-1">
            <h2 id="default-app-title" className="text-lg font-semibold">
              הגדר את PDF Viewer כתוכנת ברירת המחדל לקובצי PDF
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              לאחר ההגדרה, לחיצה כפולה על כל קובץ PDF תפתח אותו כאן, וקובצי ה‑PDF במחשב יוצגו עם הסמל הזה.{' '}
              {osLabel} לא מאפשרת לאף תוכנה להגדיר את עצמה כברירת מחדל — נדרש אישור שלך, פעם אחת, בהגדרות המערכת.
            </p>
          </div>
          <button
            type="button"
            onClick={() => choose('later')}
            aria-label="סגור"
            className="rounded p-1 text-lg leading-none text-slate-400 hover:bg-slate-700 hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          {!standalone && <InstallFirst />}

          {os === 'windows' && (
            <>
              <div className="flex flex-col gap-2">
                <a
                  ref={setPrimary}
                  href={WINDOWS_DEFAULT_APPS_URI}
                  data-testid="open-default-apps"
                  onClick={() => setSettingsOpened(true)}
                  className="inline-flex w-max items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  פתח את הגדרות „אפליקציות ברירת מחדל”
                  <span aria-hidden="true">↗</span>
                </a>
                <p className="text-xs text-slate-400" data-testid="settings-hint">
                  {settingsOpened
                    ? 'אם הדפדפן שואל „לפתוח את הגדרות?” — אשר. השאר חלון זה פתוח ובצע את השלבים בחלון ההגדרות:'
                    : 'הדפדפן ישאל אם לפתוח את ההגדרות — אשר. אחר כך בצע שלושה שלבים:'}
                </p>
              </div>
              <ol className="grid gap-3 sm:grid-cols-3" data-testid="steps">
                <Step n={1} text={<>בתיבת החיפוש „הגדר ברירת מחדל עבור סוג קובץ” הקלד <b dir="ltr">.pdf</b></>}>
                  <MockSettings>
                    <div className="text-[9px] text-slate-500">Set a default for a file type</div>
                    <div className="mt-1 flex h-6 items-center rounded border-b-2 border-sky-600 bg-white px-1.5 font-mono text-[11px] text-slate-800" dir="ltr">
                      .pdf<span className="ml-px inline-block h-3 w-px animate-pulse bg-slate-700" />
                    </div>
                  </MockSettings>
                </Step>
                <Step n={2} text={<>לחץ על התוכנה שמופיעה כעת (למשל Microsoft Edge)</>}>
                  <MockSettings>
                    <div className="text-[9px] text-slate-500" dir="ltr">.pdf</div>
                    <div className="mt-1 flex h-7 items-center gap-1.5 rounded bg-white px-1.5 text-[10px] text-slate-800 ring-2 ring-sky-500" dir="ltr">
                      <span className="h-3.5 w-3.5 rounded-sm bg-gradient-to-br from-sky-400 to-emerald-400" />
                      Microsoft Edge
                      <span className="ml-auto text-slate-400">›</span>
                    </div>
                  </MockSettings>
                </Step>
                <Step n={3} text={<>בחר <b>PDF Viewer</b> ולחץ „הגדר ברירת מחדל”</>}>
                  <MockSettings>
                    <div className="flex h-6 items-center gap-1.5 rounded bg-sky-50 px-1.5 text-[10px] font-semibold text-slate-800 ring-1 ring-sky-500" dir="ltr">
                      <img src={`${BASE}icons/icon-192.png`} alt="" className="h-3.5 w-3.5" />
                      PDF Viewer
                    </div>
                    <div className="mt-1.5 flex justify-end" dir="ltr">
                      <span className="rounded bg-sky-700 px-2 py-0.5 text-[9px] text-white">Set default</span>
                    </div>
                  </MockSettings>
                </Step>
              </ol>
              <p className="text-xs text-slate-500">
                ב‑Windows 10: בעמוד „אפליקציות ברירת מחדל” לחץ „בחר אפליקציות ברירת מחדל לפי סוג קובץ” ← <span dir="ltr">.pdf</span> ← PDF Viewer.
              </p>
              <Alt>
                <b>דרך נוספת:</b> לחיצה ימנית על קובץ PDF כלשהו ← <b>פתח באמצעות</b> ← <b>בחר אפליקציה אחרת</b> ← <b>PDF Viewer</b> ← <b>תמיד</b>.
              </Alt>
            </>
          )}

          {os === 'mac' && (
            <>
              <ol className="grid gap-3 sm:grid-cols-3" data-testid="steps">
                <Step n={1} text={<>ב‑Finder: לחיצה ימנית (Control+לחיצה) על קובץ PDF ← <b>קבל מידע</b> (<span dir="ltr">⌘I</span>)</>}>
                  <MockMac>
                    <div className="rounded bg-white/90 px-1.5 py-0.5 text-[10px] text-slate-500" dir="ltr">Open</div>
                    <div className="mt-0.5 rounded bg-sky-600 px-1.5 py-0.5 text-[10px] text-white" dir="ltr">Get Info</div>
                  </MockMac>
                </Step>
                <Step n={2} text={<>תחת <b>פתח באמצעות</b> בחר <b>PDF Viewer</b></>}>
                  <MockMac>
                    <div className="text-[9px] text-slate-500" dir="ltr">▾ Open with:</div>
                    <div className="mt-1 flex h-6 items-center gap-1.5 rounded bg-white px-1.5 text-[10px] text-slate-800 ring-2 ring-sky-500" dir="ltr">
                      <img src={`${BASE}icons/icon-192.png`} alt="" className="h-3.5 w-3.5" />
                      PDF Viewer
                      <span className="ml-auto text-slate-400">⌃</span>
                    </div>
                  </MockMac>
                </Step>
                <Step n={3} text={<>לחץ <b>שנה הכל…</b> ואשר <b>המשך</b></>}>
                  <MockMac>
                    <div className="flex justify-center" dir="ltr">
                      <span className="rounded bg-white px-2 py-0.5 text-[10px] text-slate-800 ring-2 ring-sky-500">Change All…</span>
                    </div>
                  </MockMac>
                </Step>
              </ol>
              <Alt>אחרי „שנה הכל” כל קובצי ה‑PDF ייפתחו ב‑PDF Viewer. (macOS לא מאפשרת לפתוח את חלון „קבל מידע” מתוך האפליקציה.)</Alt>
            </>
          )}

          {os === 'other' && (
            <Alt>
              במערכת זו: לחיצה ימנית על קובץ PDF ← <b>פתח באמצעות</b> ← <b>PDF Viewer</b>, ובחר להשתמש בה תמיד (אם האפשרות קיימת). פתיחת קבצים
              מהמערכת נתמכת ב‑Edge/Chrome במחשבי Windows, macOS, Linux ו‑ChromeOS.
            </Alt>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-700 bg-slate-900/40 px-5 py-3">
          <button
            type="button"
            ref={os === 'windows' ? undefined : setPrimary}
            onClick={() => choose('done')}
            data-testid="default-app-done"
            className={
              'rounded-md px-4 py-1.5 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ' +
              (settingsOpened || os !== 'windows' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'border border-slate-600 text-slate-200 hover:bg-slate-700')
            }
          >
            כבר הגדרתי
          </button>
          <button
            type="button"
            onClick={() => choose('later')}
            data-testid="default-app-later"
            className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          >
            הזכר לי מאוחר יותר
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => choose('never')}
            data-testid="default-app-never"
            className="rounded-md px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-700 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          >
            אל תשאל שוב
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function InstallFirst() {
  const { canInstall, promptInstall } = useInstallPrompt();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200" data-testid="install-first">
      <span className="flex-1">
        זו לשונית דפדפן. כדי ש‑PDF Viewer תופיע ברשימת התוכנות של המערכת, יש להתקין אותה קודם
        {canInstall ? '.' : ' (בתפריט הדפדפן ⋯ ← אפליקציות ← התקן), ולפתוח אותה מתפריט התחל.'}
      </span>
      {canInstall && (
        <button
          type="button"
          onClick={() => void promptInstall()}
          className="rounded-md bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-500"
        >
          התקן כאפליקציה
        </button>
      )}
    </div>
  );
}

function Step({ n, text, children }: { n: number; text: ReactNode; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900/50 p-2.5">
      <div className="flex items-start gap-2 text-sm">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white">{n}</span>
        <span className="min-w-0">{text}</span>
      </div>
      <div aria-hidden="true" className="mt-auto">
        {children}
      </div>
    </li>
  );
}

/** Tiny Windows 11 Settings look-alike, for the step illustrations. */
function MockSettings({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-300 bg-slate-100 p-1.5 shadow-inner">
      <div className="mb-1 flex items-center gap-1" dir="ltr">
        <span className="text-[8px] font-semibold text-slate-600">Settings › Apps › Default apps</span>
      </div>
      {children}
    </div>
  );
}

function MockMac({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-300 bg-slate-200 p-1.5 shadow-inner">
      <div className="mb-1 flex gap-0.5" dir="ltr">
        <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </div>
      {children}
    </div>
  );
}

function Alt({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-slate-300">{children}</p>;
}
