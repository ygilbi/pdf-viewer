// Pure decision logic for the root Routing Middleware (middleware.ts), kept here so it is unit-testable.
// Edge-safe: Web Crypto + fetch only, no node:* imports and no npm dependencies.
import { SESSION_COOKIE, readCookie, sessionUserValid, verifySession, type SessionUser } from './session.js';

/** Paths that are always public (the login/request pages, static files, the API, PWA plumbing). */
const PUBLIC_EXACT = new Set(['/login', '/login.html', '/download', '/download.html', '/manifest.webmanifest', '/sw.js']);
const PUBLIC_PREFIXES = ['/api/', '/assets/', '/icons/', '/tools/', '/login/', '/download/'];

/** Gated HTML files (paths with a dot are otherwise treated as public static files). */
const GATED_EXACT = new Set(['/', '/index.html', '/welcome', '/welcome.html']);

/**
 * True when the path is app HTML that requires a session: "/", "/index.html", the post-login welcome page
 * ("/welcome", "/welcome.html") and extension-less SPA paths.
 */
export function shouldGate(pathname: string): boolean {
  if (GATED_EXACT.has(pathname)) return true;
  if (PUBLIC_EXACT.has(pathname)) return false;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return false;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !last.includes('.');
}

export interface GateRequest {
  url: string;
  cookie: string | null;
  /** Sec-Fetch-Mode / Sec-Fetch-Dest request headers (null when the client does not send them). */
  secFetchMode: string | null;
  secFetchDest: string | null;
}

export interface GateDeps {
  secret: string;
  /** Load user:{email} (null when missing). May throw; the gate then fails closed. */
  loadUser(email: string): Promise<SessionUser | null>;
}

export type GateDecision = { action: 'next' } | { action: 'redirect'; location: string; reason: string };

export function loginRedirect(pathname: string, search: string): string {
  return `/login?next=${encodeURIComponent(pathname + search)}`;
}

export async function decideGate(req: GateRequest, deps: GateDeps): Promise<GateDecision> {
  const url = new URL(req.url);
  if (!shouldGate(url.pathname)) return { action: 'next' };

  // Only page navigations are redirected. Sub-resource fetches of the shell (the service worker precaching
  // index.html) pass through: the shell HTML is not secret (its JS/CSS under /assets is public anyway) and
  // redirecting them would make the service worker cache the login page as the app shell.
  const isNavigation =
    req.secFetchMode == null && req.secFetchDest == null
      ? true
      : req.secFetchMode === 'navigate' || req.secFetchDest === 'document';
  if (!isNavigation) return { action: 'next' };

  const redirect = (reason: string): GateDecision => ({ action: 'redirect', location: loginRedirect(url.pathname, url.search), reason });
  const session = await verifySession(readCookie(req.cookie, SESSION_COOKIE), deps.secret);
  if (!session) return redirect('no_session');
  try {
    const user = await deps.loadUser(session.sub);
    if (!sessionUserValid(user, session)) return redirect('inactive');
  } catch {
    return redirect('store_error');
  }
  return { action: 'next' };
}

/** Read user:{email} through the Upstash REST API directly (no SDK in the Edge bundle). */
export function restUserLoader(kvUrl: string, kvToken: string, fetchImpl: typeof fetch = fetch) {
  return async (email: string): Promise<SessionUser | null> => {
    const res = await fetchImpl(`${kvUrl.replace(/\/+$/, '')}/get/${encodeURIComponent(`user:${email}`)}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    if (!res.ok) throw new Error(`redis HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string | null };
    if (body.result == null) return null;
    return JSON.parse(body.result) as SessionUser;
  };
}
