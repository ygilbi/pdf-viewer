/**
 * /login — sign-in with Google, a one-time e-mail code or a passkey (fingerprint / Face ID / Windows Hello).
 *
 * Every load starts with GET auth/me (+ auth/providers in parallel):
 *  - signed in:        status card "ברוך/ה השב/ה, <name>!" → app (`next`) / welcome page / sign out.
 *                      No automatic redirect (no loops). With `?invite=` for another address: "sign out and continue".
 *  - default:          this device remembers a passkey (deviceKeys.ts) → primary "כניסה עם Face ID / טביעת אצבע /
 *                      Windows Hello": login/options {credentialIds} (prefetched) → startAuthentication straight
 *                      to the built-in authenticator → login/verify → `next`. Then Google / e-mail code.
 *                      No remembered passkey → NO biometric button (it would only show the cross-device QR
 *                      chooser or cancel); Google / e-mail code + a note on how to enable quick sign-in.
 *                      e-mail: auth/email/start → 6-digit code → auth/email/verify → quick-login offer → `next`
 *                      Google: full-page navigation to auth/google/start?next=… (via /login?after=google when
 *                      the quick-login offer applies)
 *  - "new user?":      tiny access-request form (name, email, honeypot) → auth/request, or "request with Google".
 *                      Already registered → welcome back + sign-in options with the e-mail prefilled.
 *  - `?invite=<token>`: auth/invite-status first. Already active → welcome back + sign-in options (e-mail prefilled,
 *                      one-click "send me a code"). Otherwise registration → passkey (register/options+verify),
 *                      "continue with e-mail code" (register/email) or Google → /welcome
 *  - `?google=pending|denied|error&reason=…&email=…`: the result of the Google round trip (URL cleaned right away).
 *
 * iOS Safari needs navigator.credentials.* to run inside the click handler: the options are prefetched
 * (usePrefetch: refreshed every 4 min and on focus / visibility) and the click never awaits the network
 * before startAuthentication / startRegistration.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  HEALTH_URL,
  WELCOME_PATH,
  emailStart,
  emailVerify,
  getMe,
  getProviders,
  googleStartUrl,
  googleStartUrlViaLogin,
  inviteStatus,
  loginOptions,
  loginVerify,
  logout,
  passkeyStatus,
  registerEmail,
  registerOptions,
  registerVerify,
  requestAccess,
  safeNext,
  type AuthUser,
} from '../auth/api';
import { deviceLoginOptions, keepKnownDeviceKeys, loadDeviceKeys, platformRegistrationOptions, removeDeviceKey, saveDeviceKey, type DeviceKey } from '../auth/deviceKeys';
import { usePrefetch } from '../auth/prefetch';
import { QuickLoginCard, canOfferQuickLogin, useQuickLoginOffer } from '../auth/QuickLogin';
import { CODE_LENGTH, EMAIL_MAX, NAME_MAX, isValidEmail, normalizeCode, normalizeEmail, validateRequest, type FieldErrors } from '../auth/validate';
import { loadLastEmail, saveLastEmail } from '../auth/lastEmail';
import { WordmarkLogo } from '../auth/Logo';
import { ArrowIcon, AuthButton, Field, FingerprintIcon, GoogleButton, MailIcon, Note, OrDivider, Spinner, buttonCls, inputCls, usePasskeySupport } from '../auth/ui';
import { MSG, RESEND_SECONDS, formatCountdown, fromApi, fromEmailVerify, fromGoogleError, fromWebAuthn, isInviteError, isUnknownCredential, type UiError } from './messages';

const BASE = import.meta.env.BASE_URL;

const params = new URLSearchParams(location.search);
const INVITE = params.get('invite')?.trim() || null;
const NEXT = safeNext(params.get('next'), BASE);
const GOOGLE_URL = googleStartUrl(NEXT);
/** Back from Google through /login (see googleStartUrlViaLogin): offer quick sign-in, then `next`. */
const AFTER_GOOGLE = params.get('after') === 'google';

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
  const keys = ['google', 'reason', 'email', 'after'];
  if (!keys.some((k) => url.searchParams.has(k))) return;
  for (const k of keys) url.searchParams.delete(k);
  try {
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
}

const PASSKEY_LABEL = 'כניסה עם Face ID / טביעת אצבע / Windows Hello';

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

type SignInMode = { kind: 'choose' } | { kind: 'email'; autoSend: boolean } | { kind: 'quick'; user: AuthUser | undefined };

type View =
  | { kind: 'loading' }
  | { kind: 'signed-in'; user: AuthUser }
  /** Just back from Google on a device that could use quick sign-in: offer it, then `next`. */
  | { kind: 'after-google'; user: AuthUser }
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
  const [keys, setKeys] = useState<DeviceKey[]>(() => loadDeviceKeys());
  const [mode, setMode] = useState<SignInMode>({ kind: 'choose' });

  useEffect(() => {
    cleanGoogleParams();
    let live = true;
    void getProviders().then((p) => live && setGoogle(p.google));
    // Drop remembered passkeys the server no longer knows (deleted / revoked account).
    const ids = loadDeviceKeys().map((k) => k.id);
    if (ids.length)
      void passkeyStatus(ids).then((r) => {
        if (live && r.ok && Array.isArray(r.known)) setKeys(keepKnownDeviceKeys(r.known));
      });
    void (async () => {
      const me = await getMe();
      if (!live) return;
      if (me.state === 'signed-in') {
        if (AFTER_GOOGLE && !INVITE) {
          if (await canOfferQuickLogin()) return live && setView({ kind: 'after-google', user: me.user });
          return go(NEXT);
        }
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
  const signIn = { keys, setKeys, mode, setMode };
  const openEmail = useCallback(() => {
    setError(null);
    setMode({ kind: 'email', autoSend: false });
    setView((v) => (v.kind === 'login' || v.kind === 'welcome-back' ? v : { kind: 'login' }));
  }, []);
  const showRequestToggle = !done && mode.kind !== 'quick' && (view.kind === 'login' || view.kind === 'register' || view.kind === 'invite-error');

  return (
    <main className="page-shell login-page" dir="rtl">
      <div className="logo-stage login-logo">
        <WordmarkLogo className="logo-fit select-none" sizes="(min-aspect-ratio: 1/1) 50vh, 80vw" />
      </div>

      <section className="flex w-full max-w-sm flex-col items-stretch gap-3 pt-5" aria-live="polite" data-view={view.kind}>
        {GOOGLE_RETURN && view.kind !== 'signed-in' && <GoogleResult result={GOOGLE_RETURN} />}

        {view.kind === 'loading' && <Spinner label="בודק את מצב הכניסה…" />}
        {view.kind === 'signed-in' && <SignedInCard user={view.user} inviteEmail={inviteEmail} deviceKeyCount={keys.length} />}
        {view.kind === 'after-google' && (
          <>
            <p className="text-center text-lg text-slate-100" data-testid="after-google">
              {view.user.name ? (
                <>
                  שלום <bdi className="font-semibold">{view.user.name}</bdi> — נכנסת בהצלחה.
                </>
              ) : (
                'נכנסת בהצלחה.'
              )}
            </p>
            <QuickLoginCard user={view.user} skipLabel="דלג" onAdded={() => window.setTimeout(() => go(NEXT), 1400)} onSkip={() => go(NEXT)} />
          </>
        )}
        {view.kind === 'login' && <SignInOptions {...panel} {...signIn} />}
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
            <SignInOptions {...panel} {...signIn} email={view.email} />
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
        {error && <ErrorBox error={error} onRequest={openRequest} onEmail={openEmail} />}

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

function SignedInCard({ user, inviteEmail, deviceKeyCount }: { user: AuthUser; inviteEmail?: string; deviceKeyCount: number }) {
  const [busy, setBusy] = useState(false);
  const offer = useQuickLoginOffer(deviceKeyCount);
  const [quickClosed, setQuickClosed] = useState(false);
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
      {offer && !otherInvite && !quickClosed && <QuickLoginCard user={user} onSkip={() => setQuickClosed(true)} />}
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

/**
 * This device remembers a passkey → biometric sign-in first (straight to Face ID / Touch ID / Windows Hello),
 * then Google / e-mail code. Otherwise Google / e-mail code only, plus how to enable quick sign-in.
 * With `email` (a known, registered address): one-click "send me a code".
 */
function SignInOptions({
  supported,
  platform,
  google,
  setError,
  setDone,
  email,
  keys,
  setKeys,
  mode,
  setMode,
}: PanelProps & { email?: string; keys: DeviceKey[]; setKeys(k: DeviceKey[]): void; mode: SignInMode; setMode(m: SignInMode): void }) {
  // Welcome-back for a known address: only that account's passkeys.
  const usable = supported ? (email ? keys.filter((k) => !k.email || sameEmail(k.email, email)) : keys) : [];
  const ids = usable.map((k) => k.id);
  const idsKey = ids.join(',');
  const fetcher = useCallback(() => loginOptions(idsKey.split(',')), [idsKey]);
  const pre = usePrefetch(ids.length ? fetcher : null, idsKey);
  const [busy, setBusy] = useState(false);
  const offerQuick = useQuickLoginOffer(keys.length);

  const welcomeBack = (user: AuthUser | undefined) => {
    setDone(user?.name ? `שלום ${user.name} — נכנסת בהצלחה. מעביר…` : 'נכנסת בהצלחה. מעביר…');
    go(NEXT);
  };

  // Click handler: synchronous up to navigator.credentials.get (iOS Safari user activation) — no awaited fetch.
  const signIn = () => {
    const taken = pre.take();
    if (!taken) return; // stale: take() started a refresh, the button shows "מכין…"
    const ceremony = startAuthentication({ optionsJSON: deviceLoginOptions(taken.options, ids) });
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        let response;
        try {
          response = await ceremony;
        } catch (err) {
          setError(fromWebAuthn(err, 'login'));
          void pre.refresh(); // fresh challenge for the next try
          return;
        }
        const v = await loginVerify(response);
        if (!v.ok) {
          if (isUnknownCredential(v.code)) setKeys(removeDeviceKey(response.id));
          setError(fromApi(v, 'login'));
          void pre.refresh();
          return;
        }
        setKeys(saveDeviceKey({ id: v.credentialId || response.id, email: v.user?.email, name: v.user?.name }));
        welcomeBack(v.user);
      } finally {
        setBusy(false);
      }
    })();
  };

  const openEmail = (autoSend: boolean) => {
    setError(null);
    setMode({ kind: 'email', autoSend });
  };

  if (mode.kind === 'quick')
    return (
      <>
        <Note tone="ok" testId="done">
          {mode.user?.name ? `שלום ${mode.user.name} — נכנסת בהצלחה.` : 'נכנסת בהצלחה.'}
        </Note>
        <QuickLoginCard
          user={mode.user}
          skipLabel="דלג"
          onAdded={() => {
            setKeys(loadDeviceKeys());
            window.setTimeout(() => go(NEXT), 1400);
          }}
          onSkip={() => welcomeBack(mode.user)}
        />
      </>
    );

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
        onSuccess={(user) => {
          // Built-in authenticator but no passkey remembered here: offer quick sign-in before leaving.
          if (offerQuick) {
            setError(null);
            setMode({ kind: 'quick', user });
          } else welcomeBack(user);
        }}
      />
    );

  const hasKey = ids.length > 0;
  const first = usable[0];
  const emailBtn = email ? (
    <AuthButton key="email" testId="send-code-to" variant={hasKey ? 'secondary' : 'primary'} icon={<MailIcon />} disabled={busy} onClick={() => openEmail(true)}>
      שלח לי קוד ל-
      <bdi dir="ltr" className="break-all">
        {email}
      </bdi>
    </AuthButton>
  ) : (
    <AuthButton key="email" testId="login-email" variant={hasKey ? 'secondary' : 'primary'} icon={<MailIcon />} disabled={busy} onClick={() => openEmail(false)}>
      כניסה עם קוד למייל
    </AuthButton>
  );
  const googleBtn = google && <GoogleButton href={offerQuick ? googleStartUrlViaLogin(NEXT) : GOOGLE_URL} />;

  return (
    <>
      {hasKey && (
        <div className="flex flex-col gap-1.5" data-testid="device-passkey">
          <AuthButton testId="login" variant="primary" icon={<FingerprintIcon />} busy={busy || (!pre.ready && !pre.error)} onClick={signIn}>
            {PASSKEY_LABEL}
          </AuthButton>
          {first && (first.name || first.email) && (
            <p className="text-center text-xs text-slate-400" data-testid="device-passkey-user">
              {first.name && <bdi className="text-slate-300">{first.name}</bdi>}
              {first.name && first.email && ' · '}
              {first.email && <bdi dir="ltr">{first.email}</bdi>}
            </p>
          )}
        </div>
      )}
      {hasKey && <OrDivider />}
      <div className="flex flex-col gap-3" data-testid="login-options" data-primary={hasKey ? 'passkey' : google ? 'google' : 'email'}>
        {googleBtn}
        {google && !hasKey && <OrDivider />}
        {emailBtn}
      </div>
      {email && (
        <LinkButton testId="other-email" onClick={() => openEmail(false)}>
          כניסה עם כתובת אחרת
        </LinkButton>
      )}
      {!hasKey && supported && platform === true && (
        <p className="text-center text-xs leading-relaxed text-slate-400" data-testid="no-device-passkey">
          {MSG.noDeviceKeyNote}
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
  // Also without WebAuthn: the answer carries the invitee's name (and validates the invite) for the e-mail option.
  // Kept fresh (iOS: startRegistration must run inside the click, without an awaited fetch) only when the
  // passkey option is shown.
  const offerPasskey = supported && platform === true;
  const fetcher = useCallback(() => registerOptions(INVITE!), []);
  const pre = usePrefetch(fetcher, 'register', offerPasskey);
  const info = pre.value;
  const loading = !info && !pre.error;
  const failed = !info && !!pre.error;
  const [busy, setBusy] = useState<'passkey' | 'email' | null>(null);

  useEffect(() => {
    if (pre.error && !pre.value) setError(fromApi(pre.error, 'register'));
  }, [pre.error, pre.value, setError]);

  const finish = () => {
    setDone('הרישום הושלם! מעביר…');
    go(WELCOME_PATH);
  };

  // Click handler: synchronous up to navigator.credentials.create.
  const registerPasskey = () => {
    const taken = pre.take();
    if (!taken) return;
    const ceremony = startRegistration({ optionsJSON: platformRegistrationOptions(taken.options) });
    setError(null);
    setBusy('passkey');
    void (async () => {
      try {
        let response;
        try {
          response = await ceremony;
        } catch (err) {
          setError(fromWebAuthn(err, 'register'));
          void pre.refresh();
          return;
        }
        const v = await registerVerify(INVITE!, response);
        if (!v.ok) {
          setError(fromApi(v, 'register')); // e.g. not_platform: the server's Hebrew text
          void pre.refresh();
          return;
        }
        saveDeviceKey({ id: v.credentialId || response.id, email: v.user?.email ?? taken.user.email, name: v.user?.name ?? taken.user.name });
        if (v.user?.email) saveLastEmail(normalizeEmail(v.user.email));
        finish();
      } finally {
        setBusy(null);
      }
    })();
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
  // Only on devices with a built-in authenticator (registrations are platform-only).
  const passkeyFirst = offerPasskey;
  const passkeyBtn = offerPasskey && (
    <AuthButton
      key="passkey"
      testId="register"
      variant="primary"
      icon={<FingerprintIcon />}
      busy={busy === 'passkey' || (!pre.ready && !pre.error)}
      disabled={busy !== null}
      onClick={registerPasskey}
    >
      רשום Face ID / טביעת אצבע
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
        .{offerPasskey ? ' אפשר להפעיל Face ID / טביעת אצבע גם אחר כך.' : ''}
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

function ErrorBox({ error, onRequest, onEmail }: { error: UiError; onRequest(): void; onEmail?(): void }) {
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
          {hints.includes('email') && onEmail && (
            <button type="button" onClick={onEmail} className="mt-1 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400" data-testid="hint-email">
              כניסה עם קוד למייל
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
