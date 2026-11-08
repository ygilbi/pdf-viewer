// Single Vercel Function for every /api/* endpoint.
//
// Vercel's Hobby plan allows at most 12 Serverless Functions per deployment,
// so the individual endpoints live in api/_routes/ (underscore folders are not
// deployed as functions) and vercel.json rewrites /api/<route> to
// /api/router?__route=<route>. Query strings (e.g. ?t=…) are preserved.

import * as approve from './_routes/approve.js';
import * as deny from './_routes/deny.js';
import * as revoke from './_routes/revoke.js';
import * as download from './_routes/download.js';
import * as health from './_routes/health.js';
import * as requestAccess from './_routes/request-access.js';
import * as authRequest from './_routes/auth/request.js';
import * as authMe from './_routes/auth/me.js';
import * as authLogout from './_routes/auth/logout.js';
import * as loginOptions from './_routes/auth/login/options.js';
import * as loginVerify from './_routes/auth/login/verify.js';
import * as registerOptions from './_routes/auth/register/options.js';
import * as registerVerify from './_routes/auth/register/verify.js';
import * as registerEmail from './_routes/auth/register/email.js';
import * as emailStart from './_routes/auth/email/start.js';
import * as emailVerify from './_routes/auth/email/verify.js';
import * as passkeyAddOptions from './_routes/auth/passkey/add/options.js';
import * as passkeyAddVerify from './_routes/auth/passkey/add/verify.js';
import * as passkeyStatus from './_routes/auth/passkey/status.js';
import * as authProviders from './_routes/auth/providers.js';
import * as inviteStatus from './_routes/auth/invite-status.js';
import * as googleStart from './_routes/auth/google/start.js';
import * as googleCallback from './_routes/auth/google/callback.js';
import * as diagReport from './_routes/diag/report.js';

type Handler = (req: Request) => Response | Promise<Response>;
type RouteModule = Partial<Record<'GET' | 'POST', Handler>>;

export const ROUTES: Record<string, RouteModule> = {
  approve,
  deny,
  revoke,
  download,
  health,
  'request-access': requestAccess,
  'auth/request': authRequest,
  'auth/me': authMe,
  'auth/logout': authLogout,
  'auth/login/options': loginOptions,
  'auth/login/verify': loginVerify,
  'auth/register/options': registerOptions,
  'auth/register/verify': registerVerify,
  'auth/register/email': registerEmail,
  'auth/email/start': emailStart,
  'auth/email/verify': emailVerify,
  'auth/passkey/add/options': passkeyAddOptions,
  'auth/passkey/add/verify': passkeyAddVerify,
  'auth/passkey/status': passkeyStatus,
  'auth/providers': authProviders,
  'auth/invite-status': inviteStatus,
  'auth/google/start': googleStart,
  'auth/google/callback': googleCallback,
  'diag/report': diagReport,
};

/** Route name from the rewrite's __route param, or from the path itself (/api/<route>). */
export function routeOf(url: URL): string {
  const fromParam = url.searchParams.get('__route');
  const raw = fromParam ?? url.pathname.replace(/^\/api\/?/, '');
  return raw.replace(/^\/+|\/+$/g, '').replace(/\.(ts|js)$/, '');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function dispatch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const mod = ROUTES[routeOf(url)];
  if (!mod) return json(404, { ok: false, code: 'not_found', error: 'הכתובת לא נמצאה.' });
  const method = req.method === 'HEAD' ? 'GET' : (req.method as 'GET' | 'POST');
  const handler = mod[method];
  if (!handler) return json(405, { ok: false, code: 'method_not_allowed', error: 'שיטה לא נתמכת.' });
  // Hand the endpoint a clean URL (/api/<route>?<original query>) without the internal param.
  url.searchParams.delete('__route');
  url.pathname = `/api/${routeOf(new URL(req.url))}`;
  return handler(new Request(url, req));
}

export function GET(req: Request): Promise<Response> {
  return dispatch(req);
}

export function POST(req: Request): Promise<Response> {
  return dispatch(req);
}
