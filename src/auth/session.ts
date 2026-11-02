/**
 * App-side auth gate state: the signed-in user (for the top menu) and the
 * startup check against GET /api/auth/me.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { LOGIN_PATH, getMe, loginUrl, logout as apiLogout, type AuthUser } from './api';

export const useAuthUser = create<{ user: AuthUser | null }>(() => ({ user: null }));

/**
 * Web only: skipped in the Electron desktop app (window.pdfDesktop) and under
 * `vite dev` unless VITE_AUTH=1. The server middleware protects the real deployment
 * either way; this gate only avoids showing the app to a signed-out visitor.
 */
export function authGateEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as { pdfDesktop?: unknown }).pdfDesktop) return false;
  if (import.meta.env.DEV && import.meta.env.VITE_AUTH !== '1') return false;
  return true;
}

/**
 * Returns true once the app may render. Signed out (401) → replaces the page with
 * /login?next=<here>. Offline / timeout / server trouble → let the app run (PWA offline use).
 */
export function useAuthGate(): boolean {
  const [ready, setReady] = useState(() => !authGateEnabled() || (typeof navigator !== 'undefined' && navigator.onLine === false));
  useEffect(() => {
    if (!authGateEnabled()) return;
    let cancelled = false;
    void getMe().then((me) => {
      if (cancelled) return;
      if (me.state === 'signed-out') {
        location.replace(loginUrl(location.pathname + location.search));
        return;
      }
      if (me.state === 'signed-in') useAuthUser.setState({ user: me.user });
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

/** Ends the session (best effort) and goes to the login page. */
export async function signOut(): Promise<void> {
  await apiLogout({ timeoutMs: 5000 });
  useAuthUser.setState({ user: null });
  location.replace(LOGIN_PATH);
}
