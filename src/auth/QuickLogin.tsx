/**
 * "Enable quick sign-in with Face ID / fingerprint on this device" — offered after an e-mail-code or
 * Google sign-in (and on /welcome) when the device has a built-in authenticator but no remembered
 * passkey. passkey/add/options is prefetched when the card appears; the click calls
 * startRegistration synchronously (iOS user activation), then passkey/add/verify and remembers the
 * credential id on this device (deviceKeys.ts).
 */
import { useCallback, useState } from 'react';
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startRegistration } from '@simplewebauthn/browser';
import { passkeyAddOptions, passkeyAddVerify, type AuthUser } from './api';
import { dismissQuickLogin, excludedIds, isQuickLoginDismissed, loadDeviceKeys, platformRegistrationOptions, saveDeviceKey } from './deviceKeys';
import { usePrefetch } from './prefetch';
import { AuthButton, FingerprintIcon, usePasskeySupport } from './ui';
import { MSG, fromApi, fromWebAuthn } from '../login/messages';

/** True when the offer makes sense here: built-in authenticator, no passkey remembered, not dismissed (30 days). */
export function quickLoginEligible(platform: boolean | null, deviceKeyCount: number, ignoreDismissal = false): boolean | null {
  if (platform === null) return null;
  return platform && deviceKeyCount === 0 && (ignoreDismissal || !isQuickLoginDismissed());
}

/** Hook form: null while the platform check runs. */
export function useQuickLoginOffer(deviceKeyCount: number, ignoreDismissal = false): boolean | null {
  const { supported, platform } = usePasskeySupport();
  return supported ? quickLoginEligible(platform, deviceKeyCount, ignoreDismissal) : false;
}

/** One-shot async check (e.g. right after the Google round trip). */
export async function canOfferQuickLogin(): Promise<boolean> {
  try {
    if (!browserSupportsWebAuthn()) return false;
    const platform = await platformAuthenticatorIsAvailable();
    return !!quickLoginEligible(platform, loadDeviceKeys().length);
  } catch {
    return false;
  }
}

export function QuickLoginCard({
  user,
  skipLabel = 'לא עכשיו',
  onAdded,
  onSkip,
}: {
  /** Signed-in user (name / e-mail remembered with the passkey). */
  user?: AuthUser | null;
  skipLabel?: string;
  onAdded?(): void;
  onSkip?(): void;
}) {
  const pre = usePrefetch(passkeyAddOptions, 'add');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const remember = useCallback(
    (ids: string[], u?: AuthUser | null) => {
      for (const id of ids.slice(0, 10).reverse()) saveDeviceKey({ id, email: u?.email ?? user?.email, name: u?.name ?? user?.name });
      setAdded(true);
      onAdded?.();
    },
    [user, onAdded],
  );

  // Click handler: no awaited network before startRegistration (Safari user activation).
  const add = () => {
    const taken = pre.take();
    if (!taken) return setError(null); // stale / failed: take() started a refresh
    const optionsJSON = platformRegistrationOptions(taken.options);
    const ceremony = startRegistration({ optionsJSON });
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        let response;
        try {
          response = await ceremony;
        } catch (err) {
          const e = fromWebAuthn(err, 'register');
          // This device already holds one of the account's passkeys: remember the account's ids (the device picks its own).
          if (e.code === 'previously_registered') return remember(excludedIds(optionsJSON));
          setError(e.code === 'cancelled' ? MSG.quickLoginCancelled : e.message);
          void pre.refresh();
          return;
        }
        const v = await passkeyAddVerify(response);
        if (!v.ok) {
          if (v.code === 'credential_exists') return remember([response.id]);
          setError(fromApi(v, 'register').message);
          void pre.refresh();
          return;
        }
        remember([v.credentialId || response.id], v.user);
      } finally {
        setBusy(false);
      }
    })();
  };

  const skip = () => {
    dismissQuickLogin();
    onSkip?.();
  };

  const shownError = error ?? (pre.error ? fromApi(pre.error, 'register').message : null);
  if (added)
    return (
      <p role="status" className="rounded-2xl border border-emerald-600/70 bg-emerald-950/50 px-4 py-3 text-center text-base font-semibold text-emerald-200" data-testid="quick-login-added">
        ✓ {MSG.quickLoginAdded}
      </p>
    );

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-sky-500/70 bg-sky-950/40 p-4 text-sm leading-relaxed text-slate-300 shadow-lg shadow-sky-950/40" data-testid="quick-login-card">
      <h2 className="flex items-center gap-2 text-base font-semibold leading-snug text-slate-50 sm:text-lg">
        <span className="text-sky-300">
          <FingerprintIcon />
        </span>
        {MSG.quickLoginTitle}
      </h2>
      <p className="text-slate-300">בפעם הבאה תיכנס/י בנגיעה או במבט — בלי לחכות לקוד במייל.</p>
      <AuthButton testId="quick-login-add" icon={<FingerprintIcon />} busy={busy || (!pre.ready && !pre.error)} onClick={add}>
        הפעל Face ID / טביעת אצבע
      </AuthButton>
      {shownError && (
        <p role="alert" className="text-center text-sm text-red-300" data-testid="quick-login-error">
          {shownError}
        </p>
      )}
      <button
        type="button"
        onClick={skip}
        disabled={busy}
        data-testid="quick-login-skip"
        className="self-center rounded px-2 py-1 text-sm text-slate-400 underline decoration-slate-600 underline-offset-4 hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
      >
        {skipLabel}
      </button>
    </section>
  );
}
