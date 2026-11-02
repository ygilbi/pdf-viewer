/**
 * /login — passkey (Face ID / fingerprint / Windows Hello) sign-in.
 *
 *  - default:          "sign in" → login/options → startAuthentication → login/verify → `next`
 *  - "new user?":      tiny access-request form (name, email, honeypot) → auth/request
 *  - `?invite=<token>`: registration → register/options → startRegistration → register/verify
 *
 * WebAuthn needs a user gesture on Safari, so the options are fetched ahead of the click
 * whenever possible (and refreshed when stale).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import {
  HEALTH_URL,
  getMe,
  loginOptions,
  loginVerify,
  registerOptions,
  registerVerify,
  requestAccess,
  safeNext,
  type AuthUser,
} from '../auth/api';
import { EMAIL_MAX, NAME_MAX, validateRequest, type FieldErrors } from '../auth/validate';
import { WordmarkLogo } from '../auth/Logo';
import { fromApi, fromWebAuthn, type UiError } from './messages';

const BASE = import.meta.env.BASE_URL;
/** Server challenges live ~5 min; refetch well before that. */
const OPTIONS_TTL_MS = 2.5 * 60_000;

const params = new URLSearchParams(location.search);
const INVITE = params.get('invite')?.trim() || null;
const NEXT = safeNext(params.get('next'), BASE);

function go(path: string) {
  location.replace(path);
}

export default function LoginPage() {
  const supported = useState(() => browserSupportsWebAuthn())[0];
  const [platform, setPlatform] = useState<boolean | null>(null);
  useEffect(() => {
    if (!supported) return;
    platformAuthenticatorIsAvailable()
      .then(setPlatform)
      .catch(() => setPlatform(false));
  }, [supported]);

  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);
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
        {!supported && (
          <Note tone="warn" testId="unsupported">
            הדפדפן הזה אינו תומך בכניסה עם Face ID / טביעת אצבע (מפתחות גישה). פתח/י את הדף ב-Safari, Chrome או Edge מעודכנים — או
            בטלפון.
          </Note>
        )}

        {INVITE ? (
          <RegisterPanel
            supported={supported}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            setDone={setDone}
          />
        ) : (
          <LoginPanel supported={supported} busy={busy} setBusy={setBusy} setError={setError} setDone={setDone} />
        )}

        {supported && platform === false && !done && (
          <Note testId="no-platform">
            לא זוהה במכשיר הזה Face ID / טביעת אצבע. אפשר להיכנס עם הטלפון: בחלון שייפתח בחר/י "טלפון או טאבלט" וסרוק/י את קוד ה-QR.
          </Note>
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

function LoginPanel(props: {
  supported: boolean;
  busy: boolean;
  setBusy(b: boolean): void;
  setError(e: UiError | null): void;
  setDone(s: string | null): void;
}) {
  const { supported, busy, setBusy, setError, setDone } = props;
  const pre = useRef<{ options: PublicKeyCredentialRequestOptionsJSON; at: number } | null>(null);
  const [signedIn, setSignedIn] = useState<AuthUser | null>(null);

  const prefetch = useCallback(async () => {
    const r = await loginOptions();
    if (r.ok) pre.current = { options: r.options, at: Date.now() };
    return r;
  }, []);

  useEffect(() => {
    if (!supported) return;
    void prefetch();
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
      setDone(v.user?.name ? `שלום ${v.user.name} — נכנסת בהצלחה. מעביר…` : 'נכנסת בהצלחה. מעביר…');
      go(NEXT);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {signedIn && (
        <a
          href={NEXT}
          data-testid="continue"
          className="rounded-lg border border-slate-700 px-4 py-2 text-center text-sm text-slate-300 hover:bg-slate-800"
        >
          מחובר/ת כ-<span dir="auto">{signedIn.name || signedIn.email}</span> — המשך
        </a>
      )}
      {supported && (
        <PrimaryButton onClick={signIn} busy={busy} testId="login">
          כניסה עם Face ID / טביעת אצבע
        </PrimaryButton>
      )}
    </>
  );
}

// ---------------------------------------------------------------- registration (invite link)

function RegisterPanel(props: {
  supported: boolean;
  busy: boolean;
  setBusy(b: boolean): void;
  setError(e: UiError | null): void;
  setDone(s: string | null): void;
}) {
  const { supported, busy, setBusy, setError, setDone } = props;
  const [info, setInfo] = useState<{ options: PublicKeyCredentialCreationOptionsJSON; user: AuthUser; at: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

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
    if (!supported) return setLoading(false);
    void load().finally(() => setLoading(false));
  }, [supported, load]);

  const register = async () => {
    if (!info) return;
    setError(null);
    setBusy(true);
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
      setDone('הרישום הושלם! מעביר לאפליקציה…');
      go(NEXT);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="טוען את פרטי ההזמנה…" />;
  if (failed || !info) return null;
  return (
    <>
      <p className="text-center text-base leading-relaxed text-slate-200" data-testid="register-greeting">
        שלום <span dir="auto" className="font-semibold">{info.user.name}</span>, רשום/י את Face ID / טביעת האצבע כדי להיכנס
      </p>
      <PrimaryButton onClick={register} busy={busy} testId="register">
        רישום Face ID / טביעת אצבע
      </PrimaryButton>
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
        הבקשה נשלחה. לאחר אישור תקבל/י מייל עם קישור חד-פעמי לרישום Face ID / טביעת אצבע.
      </Note>
    );
  if (result === 'active')
    return (
      <Note tone="ok" testId="request-active">
        את/ה כבר רשום/ה — היכנס/י עם Face ID / טביעת אצבע
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

function inputCls(bad: boolean) {
  return `w-full rounded-lg border bg-slate-800/80 px-3 py-2 text-base text-slate-100 outline-none transition focus:border-sky-400 ${
    bad ? 'border-red-400' : 'border-slate-700'
  }`;
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-slate-300">
      {label}
      {children}
      {error && <span className="text-xs text-red-300">{error}</span>}
    </label>
  );
}

function PrimaryButton({ onClick, busy, testId, children }: { onClick(): void; busy: boolean; testId: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid={testId}
      className="flex w-full items-center justify-center gap-3 rounded-xl bg-sky-500 px-6 py-4 text-lg font-semibold text-slate-950 shadow-lg shadow-sky-950/40 transition hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:cursor-wait disabled:opacity-70"
    >
      {busy ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-900/30 border-t-slate-900" /> : <FaceIcon />}
      {children}
    </button>
  );
}

function FaceIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 15.5c1.4 1.2 3.6 1.2 5 0" />
    </svg>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-3 text-sm text-slate-400" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
      {label}
    </div>
  );
}

function Note({ children, tone = 'info', testId }: { children: ReactNode; tone?: 'info' | 'ok' | 'warn'; testId?: string }) {
  const cls =
    tone === 'ok'
      ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200'
      : tone === 'warn'
        ? 'border-amber-700/60 bg-amber-950/40 text-amber-200'
        : 'border-slate-700 bg-slate-800/60 text-slate-300';
  return (
    <p className={`rounded-lg border px-3 py-2 text-center text-sm leading-relaxed ${cls}`} data-testid={testId}>
      {children}
    </p>
  );
}

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
