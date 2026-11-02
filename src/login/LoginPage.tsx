/**
 * /login — sign-in with a one-time e-mail code or a passkey (fingerprint / Face ID / Windows Hello).
 *
 *  - default:          two equal options. Primary = passkey on devices with a built-in authenticator,
 *                      e-mail code everywhere else (most PCs).
 *                      e-mail: auth/email/start → 6-digit code → auth/email/verify → `next`
 *                      passkey: login/options → startAuthentication → login/verify → `next`
 *  - "new user?":      tiny access-request form (name, email, honeypot) → auth/request
 *  - `?invite=<token>`: registration → passkey (register/options+verify) or "continue with e-mail code"
 *                      (register/email) → /welcome
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
  loginOptions,
  loginVerify,
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
import { AuthButton, Field, FingerprintIcon, MailIcon, Note, Spinner, inputCls, usePasskeySupport } from '../auth/ui';
import { RESEND_SECONDS, formatCountdown, fromApi, fromEmailVerify, fromWebAuthn, type UiError } from './messages';

const BASE = import.meta.env.BASE_URL;
/** Server challenges live ~5 min; refetch well before that. */
const OPTIONS_TTL_MS = 2.5 * 60_000;

const params = new URLSearchParams(location.search);
const INVITE = params.get('invite')?.trim() || null;
const NEXT = safeNext(params.get('next'), BASE);

const PASSKEY_LABEL = 'כניסה עם טביעת אצבע / זיהוי פנים / Windows Hello';

function go(path: string) {
  location.replace(path);
}

interface PanelProps {
  supported: boolean;
  platform: boolean | null;
  setError(e: UiError | null): void;
  setDone(s: string | null): void;
}

export default function LoginPage() {
  const { supported, platform } = usePasskeySupport();
  const [error, setError] = useState<UiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [showRequest, setShowRequest] = useState(false);

  const openRequest = useCallback(() => {
    setShowRequest(true);
    setError(null);
  }, []);

  return (
    <main className="page-shell login-page" dir="rtl">
      <div className="logo-stage login-logo">
        <WordmarkLogo className="logo-fit select-none" sizes="(min-aspect-ratio: 1/1) 50vh, 80vw" />
      </div>

      <section className="flex w-full max-w-sm flex-col items-stretch gap-3 pt-5" aria-live="polite">
        {INVITE ? (
          <RegisterPanel supported={supported} platform={platform} setError={setError} setDone={setDone} />
        ) : (
          <LoginPanel supported={supported} platform={platform} setError={setError} setDone={setDone} />
        )}

        {done && (
          <Note tone="ok" testId="done">
            {done}
          </Note>
        )}
        {error && <ErrorBox error={error} onRequest={openRequest} />}

        {!done && (
          <RequestAccess
            open={showRequest}
            onToggle={() => setShowRequest((v) => !v)}
            again={!!INVITE}
            onError={setError}
          />
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------- login

function LoginPanel({ supported, platform, setError, setDone }: PanelProps) {
  const pre = useRef<{ options: PublicKeyCredentialRequestOptionsJSON; at: number } | null>(null);
  const [signedIn, setSignedIn] = useState<AuthUser | null>(null);
  const [mode, setMode] = useState<'choose' | 'email'>('choose');
  const [busy, setBusy] = useState(false);

  const prefetch = useCallback(async () => {
    const r = await loginOptions();
    if (r.ok) pre.current = { options: r.options, at: Date.now() };
    return r;
  }, []);

  useEffect(() => {
    if (supported) void prefetch();
    // Already signed in (e.g. opened /login directly)? Offer to continue — no automatic redirect (no loops).
    void getMe().then((me) => {
      if (me.state === 'signed-in') setSignedIn(me.user);
    });
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

  const continueLink = signedIn && (
    <a
      href={NEXT}
      data-testid="continue"
      className="rounded-lg border border-slate-700 px-4 py-2 text-center text-sm text-slate-300 hover:bg-slate-800"
    >
      מחובר/ת כ-<span dir="auto">{signedIn.name || signedIn.email}</span> — המשך
    </a>
  );

  if (mode === 'email')
    return (
      <>
        {continueLink}
        <EmailCodeFlow
          setError={setError}
          onBack={() => {
            setError(null);
            setMode('choose');
          }}
          onSuccess={welcomeBack}
        />
      </>
    );

  // Most PCs have no fingerprint reader / camera: e-mail code first unless a built-in authenticator exists.
  const passkeyFirst = supported && platform === true;
  const emailBtn = (
    <AuthButton
      key="email"
      testId="login-email"
      variant={passkeyFirst ? 'secondary' : 'primary'}
      icon={<MailIcon />}
      disabled={busy}
      onClick={() => {
        setError(null);
        setMode('email');
      }}
    >
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
      {continueLink}
      <div className="flex flex-col gap-3" data-testid="login-options" data-primary={passkeyFirst ? 'passkey' : 'email'}>
        {passkeyFirst ? [passkeyBtn, emailBtn] : [emailBtn, passkeyBtn]}
      </div>
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

function EmailCodeFlow({ setError, onBack, onSuccess }: { setError(e: UiError | null): void; onBack(): void; onSuccess(user: AuthUser | undefined): void }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState(loadLastEmail);
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

function LinkButton({ onClick, testId, children }: { onClick(): void; testId: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="self-center rounded px-2 py-1 text-sm text-slate-400 underline decoration-slate-600 underline-offset-4 hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- registration (invite link)

function RegisterPanel({ supported, platform, setError, setDone }: PanelProps) {
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

function RequestAccess({ open, onToggle, again, onError }: { open: boolean; onToggle(): void; again: boolean; onError(e: UiError | null): void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<'sent' | 'active' | null>(null);
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
      setResult(r.alreadyActive ? 'active' : 'sent');
    } finally {
      setSending(false);
    }
  };

  if (result === 'sent')
    return (
      <Note tone="ok" testId="request-sent">
        הבקשה נשלחה. לאחר אישור תקבל/י מייל עם קישור חד-פעמי להשלמת הרישום.
      </Note>
    );
  if (result === 'active')
    return (
      <Note tone="ok" testId="request-active">
        את/ה כבר רשום/ה — היכנס/י עם קוד למייל או עם טביעת אצבע
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
