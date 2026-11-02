// Small Web-standard (Request/Response) helpers shared by the functions in api/.
import { ConfigError, loadConfig, type Config, type Need } from './config.js';
import { errorPage } from './templates.js';

const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  // Tokens travel in the URL: never leak them via Referer, and never let these pages be framed or indexed.
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: PAGE_HEADERS });
}

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

/** Shown to visitors on server misconfiguration; points the site owner at the diagnostics endpoint. */
export const CONFIG_ERROR_TEXT =
  'השירות אינו מוגדר כרגע (חסרים משתני סביבה בשרת). מנהל/ת האתר: פתחו את הכתובת ‎/api/health‏ כדי לראות מה חסר.';

export function jsonError(code: string, error: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return jsonResponse({ ok: false, code, error, ...extra }, status, headers);
}

/** Load config or produce the fail-closed 500 response (variable names are logged, never values). */
export function configOrError(
  needs: Need[],
  kind: 'json' | 'html',
): { config: Config; error?: undefined } | { config?: undefined; error: Response } {
  try {
    return { config: loadConfig(needs) };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`[access] configuration error: ${err.message}`);
    const error =
      kind === 'json'
        ? jsonResponse({ ok: false, code: 'server_config', error: CONFIG_ERROR_TEXT }, 500)
        : htmlResponse(errorPage('שגיאת הגדרות', CONFIG_ERROR_TEXT), 500);
    return { error };
  }
}

/** Public base URL for links in emails: APP_URL if set, else derived from the request (Vercel sets x-forwarded-*). */
export function appBaseUrl(req: Request, config: Config): string {
  if (config.appUrl) return config.appUrl;
  const url = new URL(req.url);
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host).split(',')[0].trim();
  let proto = (req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')).split(',')[0].trim().toLowerCase();
  if (proto !== 'http' && proto !== 'https') proto = 'https';
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return url.origin;
  return `${proto}://${host}`;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-vercel-forwarded-for') ?? req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip');
  return fwd?.split(',')[0].trim() || 'unknown';
}

export class BodyTooLargeError extends Error {}

/** Read the request body as text, refusing anything over `limit` bytes. */
export async function readLimitedText(req: Request, limit: number): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > limit) throw new BodyTooLargeError();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Best-effort fixed-window rate limiter kept in module memory. Serverless instances are ephemeral and
 * may run in parallel, so this only slows down naive abuse from one IP; it is not a hard guarantee.
 */
export function createRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    /** Returns true when the call is allowed. */
    hit(key: string, now = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      }
      return true;
    },
    reset(): void {
      hits.clear();
    },
  };
}

/** Read a small JSON body. Returns the parsed value, or a ready JSON error response. */
export async function readJsonBody(req: Request, limit: number): Promise<{ body: unknown; error?: undefined } | { body?: undefined; error: Response }> {
  let raw: string;
  try {
    raw = await readLimitedText(req, limit);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return { error: jsonError('too_large', 'הבקשה גדולה מדי.', 413) };
    throw err;
  }
  if (!raw.trim()) return { body: {} };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: jsonError('bad_json', 'גוף הבקשה אינו JSON תקין.', 400) };
  }
}

/** Hostname the request was made to (Vercel sets x-forwarded-host), lower-case, without port. */
export function requestHost(req: Request): string {
  const raw = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host).split(',')[0].trim();
  return raw.replace(/:\d+$/, '').toLowerCase();
}

export const isLocalHost = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

export interface CookieOptions {
  maxAge: number;
  path?: string;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${o.path ?? '/'}`,
    `Max-Age=${Math.max(0, Math.floor(o.maxAge))}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(o.secure ? ['Secure'] : []),
  ].join('; ');
}

/** Cookies are Secure everywhere except plain-http localhost development. */
export function cookieSecure(req: Request): boolean {
  return !isLocalHost(requestHost(req));
}

/** JSON response that also sets one or more cookies. */
export function jsonWithCookies(body: unknown, cookies: string[], status = 200): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}
