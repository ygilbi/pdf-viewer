/** Small UI pieces shared by /login and /welcome (Tailwind, dark, RTL). */
import { useEffect, useState, type ReactNode } from 'react';
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';

/**
 * `supported`: WebAuthn exists in this browser. `platform`: a built-in authenticator
 * (Touch ID / Face ID / fingerprint / Windows Hello) is available — null while checking.
 */
export function usePasskeySupport(): { supported: boolean; platform: boolean | null } {
  const [supported] = useState(() => {
    try {
      return browserSupportsWebAuthn();
    } catch {
      return false;
    }
  });
  const [platform, setPlatform] = useState<boolean | null>(supported ? null : false);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    platformAuthenticatorIsAvailable()
      .then((v) => live && setPlatform(v))
      .catch(() => live && setPlatform(false));
    return () => {
      live = false;
    };
  }, [supported]);
  return { supported, platform };
}

export function inputCls(bad: boolean) {
  return `w-full rounded-lg border bg-slate-800/80 px-3 py-2 text-base text-slate-100 outline-none transition focus:border-sky-400 ${
    bad ? 'border-red-400' : 'border-slate-700'
  }`;
}

export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-slate-300">
      {label}
      {children}
      {error && <span className="text-xs text-red-300">{error}</span>}
    </label>
  );
}

const BTN_BASE =
  'flex w-full items-center justify-center gap-3 rounded-xl px-5 py-3.5 text-base font-semibold [text-wrap:balance] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:cursor-wait disabled:opacity-70 sm:text-lg';
const BTN_VARIANT = {
  primary: 'bg-sky-500 text-slate-950 shadow-lg shadow-sky-950/40 hover:bg-sky-400 focus-visible:ring-sky-200',
  secondary: 'border border-slate-600 bg-slate-800 text-slate-100 hover:border-slate-500 hover:bg-slate-700 focus-visible:ring-sky-400',
} as const;

export function buttonCls(variant: keyof typeof BTN_VARIANT = 'primary') {
  return `${BTN_BASE} ${BTN_VARIANT[variant]}`;
}

export function AuthButton({
  onClick,
  busy = false,
  disabled = false,
  testId,
  variant = 'primary',
  icon,
  type = 'button',
  children,
}: {
  onClick?(): void;
  busy?: boolean;
  disabled?: boolean;
  testId: string;
  variant?: keyof typeof BTN_VARIANT;
  icon?: ReactNode;
  type?: 'button' | 'submit';
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={busy || disabled}
      data-testid={testId}
      data-variant={variant}
      aria-busy={busy || undefined}
      className={buttonCls(variant)}
    >
      {busy ? (
        <span
          className={`h-5 w-5 shrink-0 animate-spin rounded-full border-2 ${
            variant === 'primary' ? 'border-slate-900/30 border-t-slate-900' : 'border-slate-500 border-t-sky-300'
          }`}
        />
      ) : (
        icon
      )}
      <span>{children}</span>
    </button>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-3 text-sm text-slate-400" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
      {label}
    </div>
  );
}

export function Note({ children, tone = 'info', testId }: { children: ReactNode; tone?: 'info' | 'ok' | 'warn'; testId?: string }) {
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

const ICON = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export function FingerprintIcon() {
  return (
    <svg {...ICON} className="shrink-0">
      <path d="M6.5 6.2A8 8 0 0 1 20 12v1" />
      <path d="M4 12a8 8 0 0 1 .9-3.7" />
      <path d="M8 12a4 4 0 0 1 8 0v1.5a10 10 0 0 1-1.2 4.8" />
      <path d="M12 12v1.5a14 14 0 0 1-2.2 7.5" />
      <path d="M4.3 15.5c.4 1 .9 2 1.6 2.8M8.2 15.8a10 10 0 0 1-.9 3.6M17.5 16.2c.2-1 .4-2 .5-3" />
    </svg>
  );
}

export function MailIcon() {
  return (
    <svg {...ICON} className="shrink-0">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 6.5 8.5 6.5 8.5-6.5" />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg {...ICON} className="shrink-0">
      <path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" />
    </svg>
  );
}

export function WindowsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0">
      <path d="M3 5.5 10.5 4.5v7H3zM11.5 4.4 21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.4z" />
    </svg>
  );
}

export function ArrowIcon() {
  // RTL: "forward" points left.
  return (
    <svg {...ICON} className="shrink-0">
      <path d="M19 12H5m0 0 6-6m-6 6 6 6" />
    </svg>
  );
}
