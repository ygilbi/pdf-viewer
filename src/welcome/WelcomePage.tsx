/**
 * /welcome — the entry gate right after registration (also fine to revisit).
 *
 *  - "ברוך/ה הבא/ה, <name>!" + primary "כניסה לאפליקציה" → /
 *  - install card (automatic, unless already running as the installed app): the browser's PWA
 *    install dialog where `beforeinstallprompt` exists, short per-browser steps elsewhere; after
 *    `appinstalled` → "set as the default PDF app" steps for Windows / macOS
 *  - Windows browser (not the desktop app): "download the Windows software (recommended)" → /api/download
 *  - account without a passkey on a device with a built-in authenticator: optional "add quick sign-in"
 *
 * The server middleware gates /welcome; the client also checks auth/me (401 → /login?next=/welcome).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { WordmarkLogo } from '../auth/Logo';
import { LOGIN_PATH, WELCOME_PATH, getMe, loginUrl, logout, passkeyAddOptions, passkeyAddVerify, type AuthUser } from '../auth/api';
import { ArrowIcon, AuthButton, FingerprintIcon, Spinner, WindowsIcon, buttonCls, usePasskeySupport } from '../auth/ui';
import { InstallButton } from '../pwa/InstallButton';
import { useInstallPrompt } from '../pwa/installPrompt';
import { WINDOWS_DEFAULT_APPS_URI, detectOs, isStandalone } from '../pwa/defaultApp';
import { WINDOWS_DOWNLOAD_URL } from '../pwa/desktopDownload';
import { isDesktopApp } from '../desktop/bridge';
import { fromApi, fromWebAuthn } from '../login/messages';
import { INSTALL_STEPS, defaultAppSteps, detectBrowser } from './installHelp';

const BASE = import.meta.env.BASE_URL;

type Nav = Parameters<typeof detectOs>[0];
const nav = (typeof navigator === 'undefined' ? undefined : navigator) as (Nav & { maxTouchPoints?: number }) | undefined;
const OS = detectOs(nav);
const BROWSER = detectBrowser(nav);
const DESKTOP_APP = isDesktopApp();

export default function WelcomePage() {
  const [me, setMe] = useState<{ loading: boolean; user: AuthUser | null }>({ loading: true, user: null });

  useEffect(() => {
    let live = true;
    void getMe().then((r) => {
      if (!live) return;
      if (r.state === 'signed-out') {
        location.replace(loginUrl(WELCOME_PATH));
        return;
      }
      // 'unknown' (offline / server trouble): still show the page, without the name.
      setMe({ loading: false, user: r.state === 'signed-in' ? r.user : null });
    });
    return () => {
      live = false;
    };
  }, []);

  if (me.loading)
    return (
      <main className="page-shell login-page justify-center" dir="rtl">
        <Spinner label="טוען…" />
      </main>
    );

  const name = me.user?.name?.trim();
  const standalone = typeof window !== 'undefined' && isStandalone(window);
  return (
    <main className="page-shell login-page welcome-page" dir="rtl" data-testid="welcome">
      <div className="logo-stage login-logo welcome-logo">
        <WordmarkLogo className="logo-fit select-none" sizes="(min-aspect-ratio: 1/1) 30vh, 64vw" />
      </div>

      <section className="flex w-full max-w-md flex-col items-stretch gap-4 pt-4">
        <h1 className="text-center text-2xl font-semibold leading-snug text-slate-50 sm:text-3xl" data-testid="welcome-title">
          {name ? (
            <>
              ברוך/ה הבא/ה, <bdi>{name}</bdi>!
            </>
          ) : (
            'ברוך/ה הבא/ה!'
          )}
        </h1>

        {me.user?.email && <SignedInLine email={me.user.email} />}

        <a href={BASE} data-testid="enter-app" className={buttonCls('primary')}>
          <span>כניסה לאפליקציה</span>
          <ArrowIcon />
        </a>

        {!standalone && !DESKTOP_APP && <InstallCard />}
        {OS === 'windows' && !DESKTOP_APP && <WindowsCard />}
        {me.user?.hasPasskey === false && <PasskeyCard />}
      </section>
    </main>
  );
}

function SignedInLine({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    await logout({ timeoutMs: 5000 });
    location.replace(LOGIN_PATH);
  };
  return (
    <p className="-mt-2 flex flex-wrap items-center justify-center gap-x-2 text-center text-xs text-slate-400" data-testid="welcome-signed-in">
      <span>
        מחובר/ת כ-
        <bdi dir="ltr" className="text-slate-300">
          {email}
        </bdi>
      </span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={signOut} disabled={busy} data-testid="welcome-logout" className="text-slate-400 underline decoration-slate-600 underline-offset-4 hover:text-slate-200 disabled:opacity-60">
        {busy ? 'מתנתק…' : 'התנתק/י'}
      </button>
    </p>
  );
}

// ---------------------------------------------------------------- cards

function Card({ title, badge, testId, children }: { title: ReactNode; badge?: string; testId: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-slate-700/80 bg-slate-800/50 p-4 text-sm leading-relaxed text-slate-300" data-testid={testId}>
      <h2 className="flex items-start gap-2 text-base font-semibold leading-snug text-slate-100">
        <span className="flex-1">{title}</span>
        {badge && <span className="shrink-0 rounded-full bg-emerald-900/70 px-2 py-0.5 text-xs font-medium text-emerald-200">{badge}</span>}
      </h2>
      {children}
    </section>
  );
}

function InstallCard() {
  const { canInstall } = useInstallPrompt();
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const on = () => setInstalled(true);
    window.addEventListener('appinstalled', on);
    return () => window.removeEventListener('appinstalled', on);
  }, []);

  if (installed) {
    const steps = defaultAppSteps(OS);
    return (
      <Card title="✓ PDF Viewer הותקן" testId="install-card" badge="שלב 2">
        {steps ? (
          <div data-testid="default-app-steps" className="flex flex-col gap-2">
            <p className="font-semibold text-slate-100">הגדר כברירת מחדל לקובצי PDF</p>
            <ol className="list-decimal space-y-1 ps-5">
              {steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {OS === 'windows' && (
              <a href={WINDOWS_DEFAULT_APPS_URI} className={buttonCls('secondary') + ' !py-2.5 !text-sm'} data-testid="open-default-apps">
                פתח את הגדרות אפליקציות ברירת המחדל
              </a>
            )}
          </div>
        ) : (
          <p>פתח/י את PDF Viewer מהמסך הראשי של המכשיר.</p>
        )}
      </Card>
    );
  }

  return (
    <Card title="התקן את PDF Viewer כאפליקציה בדפדפן ופתח איתה קובצי PDF" testId="install-card">
      <p className="text-slate-400">חלון משלה, סמל בשולחן העבודה / במסך הבית, ופתיחה בלחיצה כפולה על קובץ PDF — בלי להוריד תוכנה.</p>
      {canInstall ? (
        <InstallButton className={buttonCls('primary')} label="התקן עכשיו" />
      ) : (
        <p className="rounded-lg bg-slate-900/60 px-3 py-2 text-slate-300" data-testid="install-steps" data-browser={BROWSER}>
          {INSTALL_STEPS[BROWSER]}
        </p>
      )}
    </Card>
  );
}

function WindowsCard() {
  return (
    <Card title="הורד את התוכנה ל-Windows" badge="מומלץ" testId="windows-card">
      <p className="text-slate-400">תוכנה מלאה למחשב — נפתחת אוטומטית בלחיצה כפולה על קובצי PDF.</p>
      <a href={WINDOWS_DOWNLOAD_URL} className={buttonCls('secondary')} data-testid="welcome-download-windows">
        <WindowsIcon />
        <span>הורד ל-Windows</span>
      </a>
      <p className="text-xs text-slate-400">
        אם מופיעה אזהרת SmartScreen: לחץ/י <bdi dir="ltr">"More info"</bdi> ← <bdi dir="ltr">"Run anyway"</bdi>.
      </p>
    </Card>
  );
}

function PasskeyCard() {
  const { supported, platform } = usePasskeySupport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  if (!supported || platform !== true) return null;

  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      const o = await passkeyAddOptions();
      if (!o.ok) return setError(fromApi(o, 'register').message);
      let response;
      try {
        response = await startRegistration({ optionsJSON: o.options });
      } catch (err) {
        const e = fromWebAuthn(err, 'register');
        if (e.code === 'previously_registered') return setAdded(true); // this authenticator is already on the account
        return setError(e.code === 'cancelled' ? 'ההוספה בוטלה.' : e.message);
      }
      const v = await passkeyAddVerify(response);
      if (!v.ok) return v.code === 'credential_exists' ? setAdded(true) : setError(fromApi(v, 'register').message);
      setAdded(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="הוסף כניסה מהירה עם טביעת אצבע / Windows Hello" badge="אופציונלי" testId="passkey-card">
      {added ? (
        <p className="text-emerald-300" data-testid="passkey-added">
          ✓ נוסף. מעכשיו אפשר להיכנס גם בלי קוד במייל.
        </p>
      ) : (
        <>
          <p className="text-slate-400">בפעם הבאה תיכנס/י בנגיעה — בלי לחכות לקוד במייל.</p>
          <AuthButton testId="add-passkey" variant="secondary" icon={<FingerprintIcon />} busy={busy} onClick={add}>
            הוסף טביעת אצבע / Windows Hello
          </AuthButton>
          {error && (
            <p role="alert" className="text-center text-xs text-red-300" data-testid="passkey-error">
              {error}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
