/**
 * /download — request form for the Windows desktop installer.
 * Downloads are approval-gated: the request is POSTed to /api/request-access,
 * the owner approves it by email, and the requester gets a personal, expiring link.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { COMPANY_MAX, EMAIL_MAX, MESSAGE_MAX, NAME_MAX, validateRequest, type FieldErrors } from './validate';

const BASE = import.meta.env.BASE_URL;
const API_URL = `${BASE}api/request-access`;

type Status =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'success' }
  | { kind: 'error'; message: string }
  | { kind: 'network' }
  | { kind: 'dev-no-api' };

type FieldName = 'name' | 'email' | 'company' | 'message';

const GENERIC_ERROR = 'אירעה שגיאה בשליחת הבקשה. נסו שוב מאוחר יותר.';

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string' && body.error.trim()) return body.error;
  } catch {
    /* not JSON */
  }
  return res.status === 429 ? 'נשלחו יותר מדי בקשות. נסו שוב מאוחר יותר.' : GENERIC_ERROR;
}

export default function DownloadPage() {
  const [values, setValues] = useState({ name: '', email: '', company: '', message: '', website: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const refs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    company: useRef<HTMLInputElement>(null),
    message: useRef<HTMLTextAreaElement>(null),
  };
  const successRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const sending = status.kind === 'sending';

  useEffect(() => {
    if (status.kind === 'success') successRef.current?.focus();
    else if (status.kind === 'error' || status.kind === 'network' || status.kind === 'dev-no-api') alertRef.current?.focus();
  }, [status.kind]);

  const set = (field: keyof typeof values, value: string) => {
    const next = { ...values, [field]: value };
    setValues(next);
    if (submitted) setErrors(validateRequest(next).errors);
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    setSubmitted(true);
    const { data, errors: errs } = validateRequest(values);
    setErrors(errs);
    const first = (['name', 'email', 'company', 'message'] as FieldName[]).find((f) => errs[f]);
    if (first) {
      refs[first].current?.focus();
      return;
    }
    setStatus({ kind: 'sending' });
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      });
    } catch {
      setStatus({ kind: 'network' });
      return;
    }
    if (res.ok) {
      setStatus({ kind: 'success' });
      return;
    }
    if (import.meta.env.DEV && res.status === 404) {
      setStatus({ kind: 'dev-no-api' });
      return;
    }
    setStatus({ kind: 'error', message: await readError(res) });
  }

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-8 sm:py-12">
      <main className="w-full max-w-xl">
        <a href={BASE} className="mx-auto block w-fit rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400" aria-label="חזרה לאפליקציה">
          <img
            src={`${BASE}icons/logo-wordmark-white.png`}
            alt="PDF — Professional Document Solutions"
            width={560}
            height={433}
            draggable={false}
            className="h-auto w-36 select-none opacity-90 sm:w-44"
          />
        </a>

        <h1 className="mt-6 text-center text-2xl font-bold text-white sm:text-3xl">הורדת PDF Viewer ל-Windows</h1>
        <p className="mx-auto mt-3 max-w-md text-center text-sm leading-relaxed text-slate-300">
          גרסת שולחן עבודה מלאה של המציג, עם מתקין רגיל ל‑<span className="whitespace-nowrap">Windows 10/11</span>.
        </p>

        <ul className="mt-5 grid gap-2 text-sm text-slate-200 sm:grid-cols-3">
          <Feature title="פתיחה מהסייר">לחיצה כפולה על קובץ PDF פותחת אותו ישירות בתוכנה</Feature>
          <Feature title="סמל PDF">קובצי ה‑PDF מוצגים בסייר עם סמל הקובץ של התוכנה</Feature>
          <Feature title="כלי מדידה">כל כלי מדידת השטחים וכתב הכמויות של האפליקציה</Feature>
        </ul>

        <section className="mt-6 rounded-xl border border-slate-700 bg-slate-800/70 p-5 shadow-xl sm:p-6" aria-labelledby={status.kind === 'success' ? 'success-title' : 'form-title'}>
          {status.kind === 'success' ? (
            <div className="py-4 text-center" data-testid="success-panel" role="status">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300" aria-hidden="true">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              </div>
              <h2 id="success-title" ref={successRef} tabIndex={-1} className="mt-3 text-lg font-semibold text-white focus:outline-none">
                הבקשה נשלחה! תקבל מייל עם קישור להורדה לאחר אישור.
              </h2>
              <p className="mt-2 text-sm text-slate-400">
                הקישור יישלח אל <span dir="ltr" className="font-medium text-slate-200">{values.email.trim()}</span> והוא אישי ותקף לכמה ימים.
              </p>
              <a href={BASE} className="mt-5 inline-block rounded-md px-3 py-1.5 text-sm font-medium text-sky-300 underline hover:text-sky-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
                חזרה לאפליקציה
              </a>
            </div>
          ) : (
            <form noValidate onSubmit={onSubmit} aria-busy={sending} data-testid="request-form">
              <h2 id="form-title" className="text-lg font-semibold text-white">בקשת הורדה</h2>
              <p className="mt-1 text-sm text-slate-400">ההורדה נשלחת לאחר אישור. מלאו את הפרטים ותקבלו קישור אישי במייל.</p>

              {status.kind === 'error' || status.kind === 'network' || status.kind === 'dev-no-api' ? (
                <div
                  ref={alertRef}
                  tabIndex={-1}
                  role="alert"
                  data-testid={status.kind === 'dev-no-api' ? 'dev-notice' : 'error-panel'}
                  className={
                    'mt-4 rounded-lg border p-3 text-sm focus:outline-none ' +
                    (status.kind === 'dev-no-api' ? 'border-amber-500/40 bg-amber-500/10 text-amber-100' : 'border-red-500/40 bg-red-500/10 text-red-100')
                  }
                >
                  {status.kind === 'error' && status.message}
                  {status.kind === 'network' && 'אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.'}
                  {status.kind === 'dev-no-api' && (
                    <>
                      <b>מצב פיתוח:</b> <span dir="ltr">/api/request-access</span> אינו זמין תחת <span dir="ltr">vite dev</span>. הריצו <span dir="ltr">vercel dev</span> כדי לבדוק את השליחה.
                    </>
                  )}
                </div>
              ) : null}

              <div className="mt-4 grid gap-4">
                <Field id="name" label="שם מלא" required error={errors.name}>
                  <input
                    ref={refs.name}
                    id="name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    maxLength={NAME_MAX + 20}
                    required
                    value={values.name}
                    onChange={(e) => set('name', e.target.value)}
                    disabled={sending}
                    aria-invalid={!!errors.name}
                    aria-describedby={errors.name ? 'name-error' : undefined}
                    className={inputClass(!!errors.name)}
                  />
                </Field>
                <Field id="email" label="אימייל" required error={errors.email}>
                  <input
                    ref={refs.email}
                    id="email"
                    name="email"
                    type="email"
                    dir="ltr"
                    inputMode="email"
                    autoComplete="email"
                    maxLength={EMAIL_MAX}
                    required
                    value={values.email}
                    onChange={(e) => set('email', e.target.value)}
                    disabled={sending}
                    aria-invalid={!!errors.email}
                    aria-describedby={errors.email ? 'email-error' : undefined}
                    className={inputClass(!!errors.email) + ' text-right placeholder:text-right'}
                    placeholder="name@example.com"
                  />
                </Field>
                <Field id="company" label="חברה" hint="(לא חובה)" error={errors.company}>
                  <input
                    ref={refs.company}
                    id="company"
                    name="company"
                    type="text"
                    autoComplete="organization"
                    maxLength={COMPANY_MAX}
                    value={values.company}
                    onChange={(e) => set('company', e.target.value)}
                    disabled={sending}
                    aria-invalid={!!errors.company}
                    aria-describedby={errors.company ? 'company-error' : undefined}
                    className={inputClass(!!errors.company)}
                  />
                </Field>
                <Field id="message" label="מטרה / הערה" hint="(לא חובה)" error={errors.message}>
                  <textarea
                    ref={refs.message}
                    id="message"
                    name="message"
                    rows={3}
                    maxLength={MESSAGE_MAX}
                    value={values.message}
                    onChange={(e) => set('message', e.target.value)}
                    disabled={sending}
                    aria-invalid={!!errors.message}
                    aria-describedby={errors.message ? 'message-error' : undefined}
                    className={inputClass(!!errors.message) + ' min-h-[5rem] resize-y'}
                  />
                </Field>

                {/* Honeypot: invisible to people and assistive tech; bots tend to fill it. */}
                <div aria-hidden="true" className="sr-only" data-testid="honeypot">
                  <label htmlFor="website">אתר</label>
                  <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" value={values.website} onChange={(e) => set('website', e.target.value)} />
                </div>
              </div>

              <button
                type="submit"
                disabled={sending}
                className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 disabled:cursor-wait disabled:bg-sky-700/70"
              >
                {sending && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />}
                {sending ? 'שולח…' : 'שליחת בקשה'}
              </button>
              <p className="mt-3 text-center text-xs text-slate-500">פרטיך ישמשו רק לאישור ההורדה.</p>
            </form>
          )}
        </section>

        <p className="mt-6 text-center text-xs text-slate-500">
          לא חייבים להתקין: אפשר להמשיך להשתמש ב<a href={BASE} className="text-slate-400 underline hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400">גרסת הדפדפן</a>.
        </p>
      </main>
    </div>
  );
}

function inputClass(invalid: boolean): string {
  return (
    'block w-full rounded-lg border bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 ' +
    'focus:outline-none focus:ring-2 disabled:opacity-60 ' +
    (invalid ? 'border-red-500/70 focus:border-red-400 focus:ring-red-400/40' : 'border-slate-600 focus:border-sky-400 focus:ring-sky-400/40')
  );
}

function Field({ id, label, required, hint, error, children }: { id: string; label: string; required?: boolean; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-200">
        {label}
        {required && (
          <span className="text-red-400" aria-hidden="true">
            {' '}*
          </span>
        )}
        {hint && <span className="font-normal text-slate-500"> {hint}</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="rounded-lg border border-slate-700/80 bg-slate-800/40 p-3">
      <div className="font-semibold text-white">{title}</div>
      <div className="mt-0.5 text-xs leading-relaxed text-slate-400">{children}</div>
    </li>
  );
}
