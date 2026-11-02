/**
 * /login — sign-in with Google, a one-time e-mail code or a passkey (fingerprint / Face ID / Windows Hello).
 *
 * Every load starts with GET auth/me (+ auth/providers in parallel):
 *  - signed in:        status card "ברוך/ה השב/ה, <name>!" → app (`next`) / welcome page / sign out.
 *                      No automatic redirect (no loops). With `?invite=` for another address: "sign out and continue".
 *  - default:          Google (when auth/providers says so), then e-mail code and passkey. Primary = passkey on
 *                      devices with a built-in authenticator, e-mail code everywhere else (most PCs).
 *                      e-mail: auth/email/start → 6-digit code → auth/email/verify → `next`
 *                      passkey: login/options → startAuthentication → login/verify → `next`
 *                      Google: full-page navigation to auth/google/start?next=…
 *  - "new user?":      tiny access-request form (name, email, honeypot) → auth/request, or "request with Google".
 *                      Already registered → welcome back + sign-in options with the e-mail prefilled.
 *  - `?invite=<token>`: auth/invite-status first. Already active → welcome back + sign-in options (e-mail prefilled,
 *                      one-click "send me a code"). Otherwise registration → passkey (register/options+verify),
 *                      "continue with e-mail code" (register/email) or Google → /welcome
 *  - `?google=pending|denied|error&reason=…&email=…`: the result of the Google round trip (URL cleaned right away).
 *
 * WebAuthn needs a user gesture on Safari, so the options are fetched ahead of the click
 * whenever possible (and refreshed when stale).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import {
  HEALTH_URL,
  WELCOME_PATH,
  emailStart,
  emailVerify,
  getMe,
  getProviders,
  googleStartUrl,
  inviteStatus,
  loginOptions,
  loginVerify,
  logout,
  registerEmail,
  registerOptions,
  registerVerify,
  requestAccess,
  safeNext,
  type AuthUser,
} from '../auth/api';
import { CODE_LENGTH, EMAIL_MAX, NAME_MAX, isValidEmail, normalizeCode, normalizeEmail, validateRequest, type FieldErrors } from '../auth/validate';
import { loadLastEmail, saveLastEmail } from '../auth/lastEmail';
import { WordmarkLogo } from '../auth/Logo';
import { ArrowIcon, AuthButton, Field, FingerprintIcon, GoogleButton, MailIcon, Note, OrDivider, Spinner, buttonCls, inputCls, usePasskeySupport } from '../auth/ui';
import { RESEND_SECONDS, formatCountdown, fromApi, fromEmailVerify, fromGoogleError, fromWebAuthn, isInviteError, type UiError } from './messages';

const BASE = import.meta.env.BASE_URL;
/** Server challenges live ~5 min; refetch well before that. */
const OPTIONS_TTL_MS = 2.5 * 60_000;

const params = new URLSearchParams(location.search);
const INVITE = params.get('invite')?.trim() || null;
const NEXT = safeNext(params.get('next'), BASE);
const GOOGLE_URL = googleStartUrl(NEXT);

type GoogleReturn = { kind: 'pending'; email: string | null } | { kind: 'denied' } | { kind: 'error'; reason: string | null } | null;
const GOOGLE_RETURN: GoogleReturn = (() => {
  const g = params.get('google');
  if (g === 'pending') return { kind: 'pending', email: params.get('email')?.trim() || null };
  if (g === 'denied') return { kind: 'denied' };
  if (g === 'error') return { kind: 'error', reason: params.get('reason') };
  return null;
})();

/** Drop the one-shot Google result params (keep `next` / `invite`) so a reload doesn't repeat the message. */
function cleanGoogleParams() {
  const url = new URL(location.href);
  if (!['google', 'reason', 'email'].some((k) => url.searchParams.has(k))) return;
  for (const k of ['google', 'reason', 'email']) url.searchParams.delete(k);
  try {
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
}

const PASSKEY_LABEL = 'כניסה עם טביעת אצבע / זיהוי פנים / Windows Hello';

function go(path: string) {
  location.replace(path);
}

const sameEmail = (a: string | undefined, b: string | undefined) => !!a && !!b && normalizeEmail(a) === normalizeEmail(b);

interface PanelProps {
  supported: boolean;
  platform: boolean | null;
  google: boolean;
  setError(e: UiError | null): void;
  setDone(s: string | null): void;
}

type View =
  | { kind: 'loading' }
  | { kind: 'signed-in'; user: AuthUser }
  | { kind: 'login' }
  /** Already registered (active invite, or "request access" for a registered address): sign in, e-mail prefilled. */
  | { kind: 'welcome-back'; name?: string; email: string }
  | { kind: 'register' }
  /** Invite expired / used / unknown: error + request again, or sign in. */
  | { kind: 'invite-error' };

export default function LoginPage() {
  const { supported, platform } = usePasskeySupport();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [google, setGoogle] = useState(false);
  const [inviteEmail, setInviteEmail] = useState<string | undefined>();
  const [error, setError] = useState<UiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [showRequest, setShowRequest] = useState(false);

  useEffect(() => {
    cleanGoogleParams();
    let live = true;
    void getProviders().then((p) => live && setGoogle(p.google));
    void (async () => {
      const me = await getMe();
      if (!live) return;
      if (me.state === 'signed-in') {
        setView({ kind: 'signed-in', user: me.user });
        if (INVITE) {
          const s = await inviteStatus(INVITE);
          if (live && s.ok) setInviteEmail(s.email);
        }
        return;
      }
      if (!INVITE) return setView({ kind: 'login' });
      const s = await inviteStatus(INVITE);
      if (!live) return;
      if (s.ok) {
        if (s.email) setInviteEmail(s.email);
        setView(s.status === 'active' ? { kind: 'welcome-back', name: s.name, email: s.email } : { kind: 'register' });
        return;
      }
      if (s.status === 400 || isInviteError(s.code, s.status)) {
        setError(fromApi(s, 'register'));
        return setView({ kind: 'invite-error' });
      }
      // Older backend without invite-status / transient trouble: the registration panel validates the invite itself.
      setView({ kind: 'register' });
    })();
    return () => {
      live = false;
    };
  }, []);

  const openRequest = useCallback(() => {
    setShowRequest(true);
    setError(null);
  }, []);

  // After a failed Google round trip the error box carries its own "try again with Google" button.
  const googleRetry = GOOGLE_RETURN?.kind === 'error' && fromGoogleError(GOOGLE_RETURN.reason).retry;
  const panel = { supported, platform, google: google && !googleRetry, setError, setDone };
  const showRequestToggle = !done && (view.kind === 'login' || view.kind === 'register' || view.kind === 'invite-error');

  return (
    <main className="page-shell login-page" dir="rtl">
      <div className="logo-stage login-logo">
        <WordmarkLogo className="logo-fit select-none" sizes="(min-aspect-ratio: 1/1) 50vh, 80vw" />
      </div>

      <section className="flex w-full max-w-sm flex-col items-stretch gap-3 pt-5" aria-live="polite" data-view={view.kind}>
        {GOOGLE_RETURN && view.kind !== 'signed-in' && <GoogleResult result={GOOGLE_RETURN} />}

        {view.kind === 'loading' && <Spinner label="בודק את מצב הכניסה…" />}
        {view.kind === 'signed-in' && <SignedInCard user={view.user} inviteEmail={inviteEmail} />}
        {view.kind === 'login' && <SignInOptions {...panel} />}
        {view.kind === 'welcome-back' && (
          <>
            <div className="text-center" data-testid="welcome-back">
              <p className="text-lg text-slate-100">
                {view.name ? (
                  <>
                    ברוך/ה השב/ה, <bdi className="font-semibold">{view.name}</bdi>!
                  </>
                ) : (
                  'ברוך/ה השב/ה!'
                )}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-slate-400">את/ה כבר רשום/ה — בחר/י איך להיכנס:</p>
            </div>
            <SignInOptions {...panel} email={view.email} />
          </>
        )}
        {view.kind === 'register' && <RegisterPanel {...panel} />}
        {view.kind === 'invite-error' && (
          <button type="button" onClick={() => (setError(null), setView({ kind: 'login' }))} data-testid="invite-signin" className={buttonCls('secondary')}>
            כבר רשום/ה? כניסה
          </button>
        )}

        {done && (
          <Note tone="ok" testId="done">
            {done}
          </Note>
        )}
        {error && <ErrorBox error={error} onRequest={openRequest} />}

        {showRequestToggle && (
          <RequestAccess
            open={showRequest}
            onToggle={() => setShowRequest((v) => !v)}
            again={!!INVITE}
            google={google}
            onError={setError}
            onAlreadyActive={(email) => {
              setShowRequest(false);
              setError(null);
              setView({ kind: 'welcome-back', email });
            }}
          />
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------- signed in / Google result

function SignedInCard({ user, inviteEmail }: { user: AuthUser; inviteEmail?: string }) {
  const [busy, setBusy] = useState(false);
  const name = user.name?.trim();
  const otherInvite = !!inviteEmail && !sameEmail(inviteEmail, user.email);
  const signOut = async () => {
    setBusy(true);
    await logout({ timeoutMs: 5000 });
    location.reload(); // same URL: `next` / `invite` survive, so the invite flow continues signed out
  };
  return (
    <div className="flex flex-col gap-3" data-testid="signed-in">
      <div className="text-center">
        <p className="text-xl font-semibold text-slate-50" data-testid="signed-in-title">
          {name ? (
            <>
              ברוך/ה השב/ה, <bdi>{name}</bdi>!
            </>
          ) : (
            'ברוך/ה השב/ה!'
          )}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-400" data-testid="signed-in-as">
          את/ה כבר מחובר/ת כ-
          <bdi dir="ltr" className="text-slate-200">
            {user.email}
          </bdi>
        </p>
      </div>
      {otherInvite && (
        <div className="flex flex-col items-center gap-1.5 rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-center text-sm leading-relaxed text-amber-200" data-testid="invite-other">
          <span>
            הקישור הזה שייך ל-
            <bdi dir="ltr" className="font-semibold">
              {inviteEmail}
            </bdi>
          </span>
          <button type="button" onClick={signOut} disabled={busy} data-testid="logout-continue" className="text-amber-100 underline underline-offset-4 hover:text-white disabled:opacity-60">
            התנתק/י והמשך
          </button>
        </div>
      )}
      <a href={NEXT} data-testid="enter-app" className={buttonCls('primary')}>
        <span>כניסה לאפליקציה</span>
        <ArrowIcon />
      </a>
      <a href={WELCOME_PATH} data-testid="to-welcome" className={buttonCls('secondary')}>
        עמוד הפתיחה
      </a>
      <LinkButton onClick={signOut} testId="logout" disabled={busy}>
        {busy ? 'מתנתק…' : 'התנתק/י'}
      </LinkButton>
    </div>
  );
}

function GoogleResult({ result }: { result: NonNullable<GoogleReturn> }) {
  if (result.kind === 'pending')
    return (
      <Note tone="ok" testId="google-pending">
        בקשת הגישה נשלחה לאישור. תקבל/י מייל לאחר האישור.
        {result.email && (
          <>
            <br />
            <bdi dir="ltr" className="text-xs text-emerald-300">
              {result.email}
            </bdi>
          </>
        )}
      </Note>
    );
  if (result.kind === 'denied')
    return (
      <Note tone="warn" testId="google-denied">
        הגישה נדחתה. לא ניתן להיכנס עם חשבון ה-Google הזה.
      </Note>
    );
  const e = fromGoogleError(result.reason);
  return (
    <div className="flex flex-col gap-2" data-testid="google-error" data-code={e.code}>
      <ErrorBox error={e} onRequest={() => undefined} />
      {e.retry && <GoogleButton href={GOOGLE_URL} testId="google-retry">נסה/י שוב עם Google</GoogleButton>}
    </div>
  );
}

// ---------------------------------------------------------------- sign-in options

/** Google / e-mail code / passkey. With `email` (a known, registered address): one-click "send me a code". */
function SignInOptions({ supported, platform, google, setError, setDone, email }: PanelProps & { email?: string }) {
  const pre = useRef<{ options: PublicKeyCredentialRequestOptionsJSON; at: number } | null>(null);
  const [mode, setMode] = useState<{ kind: 'choose' } | { kind: 'email'; autoSend: boolean }>({ kind: 'choose' });
  const [busy, setBusy] = useState(false);

  const prefetch = useCallback(async () => {
    const r = await loginOptions();
    if (r.ok) pre.current = { options: r.options, at: Date.now() };
    return r;
  }, []);

  useEffect(() => {
    if (supported) void prefetch();
  }, [supported, prefetch]);

  const signIn = async () => {
    setError(null);
    setBusy(true);
    try {
      let options = pre.current && Date.now() - pre.current.at < OPTIONS_TTL_MS ? pre.current.options : null;
      pre.current = null; // a challenge is single-use
      if (!options) {
        const r = await prefetch();
        pre.current = null;
        if (!r.ok) return setError(fromApi(r, 'login'));
        options = r.options;
      }
      let response;
      try {
        response = await startAuthentication({ optionsJSON: options });
      } catch (err) {
        setError(fromWebAuthn(err, 'login'));
        void prefetch(); // fresh challenge for the next try
        return;
      }
      const v = await loginVerify(response);
      if (!v.ok) {
        setError(fromApi(v, 'login'));
        void prefetch();
        return;
      }
      welcomeBack(v.user);
    } finally {
      setBusy(false);
    }
  };

  const welcomeBack = (user: AuthUser | undefined) => {
    setDone(user?.name ? `שלום ${user.name} — נכנסת בהצלחה. מעביר…` : 'נכנסת בהצלחה. מעביר…');
    go(NEXT);
  };

  if (mode.kind === 'email')
    return (
      <EmailCodeFlow
        initialEmail={mode.autoSend ? email : undefined}
        autoSend={mode.autoSend}
        setError={setError}
        onBack={() => {
          setError(null);
          setMode({ kind: 'choose' });
        }}
        onSuccess={welcomeBack}
      />
    );

  // Most PCs have no fingerprint reader / camera: e-mail code first unless a built-in authenticator exists.
  const passkeyFirst = supported && platform === true && !email;
  const openEmail = (autoSend: boolean) => {
    setError(null);
    setMode({ kind: 'email', autoSend });
  };
  const emailBtn = email ? (
    <AuthButton key="email" testId="send-code-to" variant="primary" icon={<MailIcon />} disabled={busy} onClick={() => openEmail(true)}>
      שלח לי קוד ל-
      <bdi dir="ltr" className="break-all">
        {email}
      </bdi>
    </AuthButton>
  ) : (
    <AuthButton key="email" testId="login-email" variant={passkeyFirst ? 'secondary' : 'primary'} icon={<MailIcon />} disabled={busy} onClick={() => openEmail(false)}>
      כניסה עם קוד למייל
    </AuthButton>
  );
  const passkeyBtn = supported && (
    <AuthButton key="passkey" testId="login" variant={passkeyFirst ? 'primary' : 'secondary'} icon={<FingerprintIcon />} busy={busy} onClick={signIn}>
      {PASSKEY_LABEL}
    </AuthButton>
  );

  return (
    <>
      {google && (
        <>
          <GoogleButton href={GOOGLE_URL} />
          <OrDivider />
        </>
      )}
      <div className="flex flex-col gap-3" data-testid="login-options" data-primary={passkeyFirst ? 'passkey' : 'email'}>
        {passkeyFirst ? [passkeyBtn, emailBtn] : [emailBtn, passkeyBtn]}
      </div>
      {email && (
        <LinkButton testId="other-email" onClick={() => openEmail(false)}>
          כניסה עם כתובת אחרת
        </LinkButton>
      )}
      {!supported && (
        <p className="text-center text-xs leading-relaxed text-slate-400" data-testid="unsupported">
          הדפדפן הזה אינו תומך בכניסה עם טביעת אצבע / זיהוי פנים — היכנס/י עם קוד למייל.
        </p>
      )}
      {supported && platform === false && (
        <p className="text-center text-xs leading-relaxed text-slate-400" data-testid="no-platform">
          אין במחשב טביעת אצבע / Windows Hello? היכנס/י עם קוד למייל — או עם הטלפון הרשום: בחלון הכניסה בחר/י "טלפון או טאבלט" וסרוק/י את קוד ה-QR.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------- e-mail code

function EmailCodeFlow({
  setError,
  onBack,
  onSuccess,
  initialEmail,
  autoSend = false,
}: {
  setError(e: UiError | null): void;
  onBack(): void;
  onSuccess(user: AuthUser | undefined): void;
  /** Prefill (a known registered address) instead of the remembered one. */
  initialEmail?: string;
  /** Mail the code right away (one-click "send me a code to <email>"). */
  autoSend?: boolean;
}) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState(() => initialEmail || loadLastEmail());
  const [emailError, setEmailError] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  /** The current code can no longer work (expired / burned): only "send again" helps. */
  const [dead, setDead] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const submitted = useRef<string | null>(null);

  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= cooldownUntil) window.clearInterval(t);
    }, 250);
    return () => window.clearInterval(t);
  }, [cooldownUntil]);

  useEffect(() => {
    if (step === 'email') emailRef.current?.focus();
    else codeRef.current?.focus();
  }, [step]);

  const startCooldown = (seconds: number) => {
    const n = Date.now();
    setNow(n);
    setCooldownUntil(n + seconds * 1000);
  };

  const send = async (resend: boolean) => {
    const addr = normalizeEmail(email);
    if (!addr) return setEmailError('נא למלא כתובת אימייל');
    if (!isValidEmail(addr)) return setEmailError('כתובת האימייל אינה תקינה');
    setEmailError(undefined);
    setError(null);
    setNotice(null);
    setSending(true);
    try {
      const r = await emailStart(addr);
      if (r.ok) {
        saveLastEmail(addr);
        setEmail(addr);
        setCode('');
        submitted.current = null;
        setDead(false);
        setStep('code');
        startCooldown(RESEND_SECONDS);
        setNotice(resend ? 'נשלח קוד חדש. הקוד הקודם אינו תקף עוד.' : null);
        codeRef.current?.focus();
        return;
      }
      if (r.code === 'too_soon') {
        // A code was mailed moments ago — it is still valid; wait before asking for another.
        saveLastEmail(addr);
        setStep('code');
        startCooldown(r.retryAfter ?? RESEND_SECONDS);
        setNotice(resend ? r.error : 'כבר שלחנו קוד לכתובת הזו לפני רגע — בדוק/י את תיבת הדואר.');
        return;
      }
      if (r.retryAfter) startCooldown(r.retryAfter);
      setError(fromApi(r, 'login'));
    } finally {
      setSending(false);
    }
  };

  const verify = async (value: string) => {
    if (value.length !== CODE_LENGTH || submitted.current === value || verifying) return;
    submitted.current = value;
    setError(null);
    setNotice(null);
    setVerifying(true);
    try {
      const r = await emailVerify(normalizeEmail(email), value);
      if (r.ok) {
        saveLastEmail(normalizeEmail(email));
        onSuccess(r.user);
        return;
      }
      const e = fromEmailVerify(r);
      setError(e);
      setCode('');
      submitted.current = null;
      if (e.resend) {
        setDead(true);
        setCooldownUntil(0);
      }
    } finally {
      setVerifying(false);
      window.setTimeout(() => codeRef.current?.focus(), 0);
    }
  };

  const autoSent = useRef(false);
  useEffect(() => {
    if (!autoSend || autoSent.current) return;
    autoSent.current = true;
    void send(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  const onCode = (raw: string) => {
    const v = normalizeCode(raw);
    setCode(v);
    if (v.length === CODE_LENGTH) void verify(v);
  };

  if (step === 'email')
    return (
      <form
        noValidate
        className="flex flex-col gap-3"
        data-testid="email-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send(false);
        }}
      >
        <Field label="כתובת האימייל שלך" error={emailError}>
          <input
            ref={emailRef}
            name="email"
            type="email"
            dir="ltr"
            inputMode="email"
            autoComplete="email"
            maxLength={EMAIL_MAX}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="email-input"
            className={inputCls(!!emailError) + ' py-3 text-left'}
          />
        </Field>
        <AuthButton type="submit" testId="send-code" busy={sending} icon={<MailIcon />}>
          שלח קוד
        </AuthButton>
        <LinkButton onClick={onBack} testId="back">
          חזרה לאפשרויות הכניסה
        </LinkButton>
      </form>
    );

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      data-testid="code-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void verify(code);
      }}
    >
      <p className="text-center text-sm leading-relaxed text-slate-300" data-testid="code-sent">
        שלחנו קוד בן {CODE_LENGTH} ספרות אל{' '}
        <bdi dir="ltr" className="font-semibold text-slate-100">
          {normalizeEmail(email)}
        </bdi>
        <br />
        <span className="text-xs text-slate-400">הקוד תקף לכמה דקות. לא הגיע? בדוק/י גם בתיקיית הספאם.</span>
      </p>
      <label className="sr-only" htmlFor="otp">
        קוד חד-פעמי
      </label>
      <input
        ref={codeRef}
        id="otp"
        name="one-time-code"
        type="text"
        dir="ltr"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        enterKeyHint="done"
        maxLength={CODE_LENGTH * 3}
        placeholder={'•'.repeat(CODE_LENGTH)}
        value={code}
        disabled={dead}
        onChange={(e) => onCode(e.target.value)}
        onPaste={(e) => {
          e.preventDefault();
          onCode(e.clipboardData.getData('text'));
        }}
        aria-describedby="code-help"
        data-testid="code-input"
        className="w-full rounded-xl border border-slate-600 bg-slate-800/80 px-3 py-3 text-center font-mono text-3xl tracking-[0.5em] text-slate-50 outline-none transition placeholder:text-slate-600 focus:border-sky-400 disabled:opacity-50"
      />
      <span id="code-help" className="sr-only">
        הקלד/י או הדבק/י את הקוד — הבדיקה מתבצעת אוטומטית
      </span>
      {notice && (
        <Note tone="ok" testId="code-notice">
          {notice}
        </Note>
      )}
      {!dead && (
        <AuthButton type="submit" testId="verify-code" busy={verifying} disabled={code.length !== CODE_LENGTH}>
          {verifying ? 'בודק…' : 'כניסה'}
        </AuthButton>
      )}
      <div className="flex items-center justify-between gap-2 text-sm">
        <button
          type="button"
          onClick={() => void send(true)}
          disabled={remaining > 0 || sending}
          data-testid="resend"
          className={
            dead
              ? 'flex-1 rounded-lg bg-sky-500 px-4 py-2.5 font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-60'
              : 'rounded px-2 py-1 text-sky-300 underline underline-offset-4 hover:text-sky-200 disabled:cursor-default disabled:text-slate-500 disabled:no-underline'
          }
        >
          {sending ? 'שולח…' : remaining > 0 ? `שלח שוב בעוד ${formatCountdown(remaining)}` : dead ? 'שלח קוד חדש' : 'שלח שוב'}
        </button>
        <LinkButton
          testId="change-email"
          onClick={() => {
            setError(null);
            setNotice(null);
            setCode('');
            setStep('email');
          }}
        >
          שינוי כתובת
        </LinkButton>
      </div>
    </form>
  );
}

function LinkButton({ onClick, testId, disabled, children }: { onClick(): void; testId: string; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="self-center rounded px-2 py-1 text-sm text-slate-400 underline decoration-slate-600 underline-offset-4 hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- registration (invite link)

function RegisterPanel({ supported, platform, google, setError, setDone }: PanelProps) {
  const [info, setInfo] = useState<{ options: PublicKeyCredentialCreationOptionsJSON; user: AuthUser; at: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<'passkey' | 'email' | null>(null);

  const load = useCallback(async () => {
    const r = await registerOptions(INVITE!);
    if (r.ok) {
      setInfo({ options: r.options, user: r.user, at: Date.now() });
      return r;
    }
    setFailed(true);
    setError(fromApi(r, 'register'));
    return r;
  }, [setError]);

  useEffect(() => {
    // Also without WebAuthn: the answer carries the invitee's name (and validates the invite) for the e-mail option.
    void load().finally(() => setLoading(false));
  }, [load]);

  const finish = () => {
    setDone('הרישום הושלם! מעביר…');
    go(WELCOME_PATH);
  };

  const registerPasskey = async () => {
    if (!info) return;
    setError(null);
    setBusy('passkey');
    try {
      let options = info.options;
      if (Date.now() - info.at > OPTIONS_TTL_MS) {
        const r = await load();
        if (!r.ok) return;
        options = r.options;
      }
      let response;
      try {
        response = await startRegistration({ optionsJSON: options });
      } catch (err) {
        setError(fromWebAuthn(err, 'register'));
        void load();
        return;
      }
      const v = await registerVerify(INVITE!, response);
      if (!v.ok) {
        setError(fromApi(v, 'register'));
        return;
      }
      finish();
    } finally {
      setBusy(null);
    }
  };

  const registerWithEmail = async () => {
    setError(null);
    setBusy('email');
    try {
      const r = await registerEmail(INVITE!);
      if (!r.ok) return setError(fromApi(r, 'register'));
      if (r.user?.email) saveLastEmail(normalizeEmail(r.user.email));
      finish();
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Spinner label="טוען את פרטי ההזמנה…" />;
  if (failed || !info) return null;
  const passkeyFirst = supported && platform === true;
  const passkeyBtn = supported && (
    <AuthButton
      key="passkey"
      testId="register"
      variant={passkeyFirst ? 'primary' : 'secondary'}
      icon={<FingerprintIcon />}
      busy={busy === 'passkey'}
      disabled={busy !== null}
      onClick={registerPasskey}
    >
      רשום טביעת אצבע / זיהוי פנים / Windows Hello
    </AuthButton>
  );
  const emailBtn = (
    <AuthButton
      key="email"
      testId="register-email"
      variant={passkeyFirst ? 'secondary' : 'primary'}
      icon={<MailIcon />}
      busy={busy === 'email'}
      disabled={busy !== null}
      onClick={registerWithEmail}
    >
      המשך עם קוד במייל (בלי טביעת אצבע)
    </AuthButton>
  );
  return (
    <>
      <div className="text-center" data-testid="register-greeting">
        <p className="text-lg text-slate-100">
          שלום <span dir="auto" className="font-semibold">{info.user.name}</span>!
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-400">איך תרצה/י להיכנס מעכשיו?</p>
      </div>
      <div className="flex flex-col gap-3" data-testid="register-options" data-primary={passkeyFirst ? 'passkey' : 'email'}>
        {passkeyFirst ? [passkeyBtn, emailBtn] : [emailBtn, passkeyBtn]}
        {google && <GoogleButton key="google" href={GOOGLE_URL} testId="register-google" />}
      </div>
      <p className="text-center text-xs leading-relaxed text-slate-400">
        בכניסה עם קוד, בכל פעם יישלח קוד חד-פעמי אל{' '}
        <bdi dir="ltr" className="text-slate-300">
          {info.user.email}
        </bdi>
        . אפשר להוסיף טביעת אצבע גם אחר כך.
      </p>
    </>
  );
}

// ---------------------------------------------------------------- access request

function RequestAccess({
  open,
  onToggle,
  again,
  google,
  onError,
  onAlreadyActive,
}: {
  open: boolean;
  onToggle(): void;
  again: boolean;
  google: boolean;
  onError(e: UiError | null): void;
  /** The address is already registered: switch to signing in with it. */
  onAlreadyActive(email: string): void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) nameRef.current?.focus();
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { data, errors } = validateRequest({ name, email, website });
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    onError(null);
    setSending(true);
    try {
      const r = await requestAccess({ name: data.name, email: data.email, website: data.website });
      if (!r.ok) return onError(fromApi(r, 'request'));
      if (r.alreadyActive) {
        saveLastEmail(data.email);
        onAlreadyActive(data.email);
      } else setSent(true);
    } finally {
      setSending(false);
    }
  };

  if (sent)
    return (
      <Note tone="ok" testId="request-sent">
        הבקשה נשלחה. לאחר אישור תקבל/י מייל עם קישור חד-פעמי להשלמת הרישום.
      </Note>
    );

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="toggle-request"
        className="rounded px-2 py-1 text-sm text-slate-400 underline decoration-slate-600 underline-offset-4 hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
      >
        {again ? 'בקש גישה מחדש' : 'משתמש חדש? בקש גישה'}
      </button>
      {open && (
        <form onSubmit={submit} noValidate className="flex w-full flex-col gap-2.5" data-testid="request-form">
          <Field label="שם מלא" error={fieldErrors.name}>
            <input
              ref={nameRef}
              name="name"
              autoComplete="name"
              maxLength={NAME_MAX}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls(!!fieldErrors.name)}
            />
          </Field>
          <Field label="אימייל" error={fieldErrors.email}>
            <input
              name="email"
              type="email"
              dir="ltr"
              inputMode="email"
              autoComplete="email"
              maxLength={EMAIL_MAX}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls(!!fieldErrors.email) + ' text-left'}
            />
          </Field>
          {/* Honeypot: invisible to people, filled by bots. */}
          <div aria-hidden="true" className="sr-only">
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </label>
          </div>
          <button
            type="submit"
            disabled={sending}
            data-testid="request-submit"
            className="mt-1 rounded-lg bg-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-100 transition hover:bg-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60"
          >
            {sending ? 'שולח…' : 'שליחת בקשה'}
          </button>
          {google && (
            <>
              <OrDivider />
              {/* Unknown Google accounts get an access request automatically. */}
              <GoogleButton href={GOOGLE_URL} testId="request-google">
                או בקש גישה עם Google
              </GoogleButton>
            </>
          )}
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- bits

function ErrorBox({ error, onRequest }: { error: UiError; onRequest(): void }) {
  const hints = error.hints ?? [];
  return (
    <div role="alert" data-testid="error" data-code={error.code} className="rounded-lg border border-red-800/70 bg-red-950/40 px-3 py-2 text-center text-sm leading-relaxed text-red-200">
      {error.message}
      {hints.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs">
          {/* With an invite the toggle right below already reads "בקש גישה מחדש". */}
          {hints.includes('request') && !INVITE && (
            <button type="button" onClick={onRequest} className="text-sky-300 underline underline-offset-2 hover:text-sky-200" data-testid="hint-request">
              בקש גישה
            </button>
          )}
          {hints.includes('health') && (
            <a href={HEALTH_URL} target="_blank" rel="noopener" className="text-slate-400 underline underline-offset-2 hover:text-slate-200" data-testid="hint-health">
              בדיקת הגדרות השרת
            </a>
          )}
        </div>
      )}
    </div>
  );
}
