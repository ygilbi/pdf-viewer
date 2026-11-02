// Vercel Routing Middleware (framework-agnostic; runs on the Edge before the static app is served).
// Gates the app HTML behind a passkey session: no valid pv_session cookie (or the user is no longer
// 'active' in Redis) → 302 to /login?next=<path>. Decision logic lives in api/_lib/gate.ts (unit-tested).
// Never gated: /login, /download, /api/*, /assets/*, /icons/*, /tools/*, /manifest.webmanifest, /sw.js.
import { decideGate, restUserLoader } from './api/_lib/gate.js';

export const config = {
  // "/" , "/index.html" and extension-less paths outside the public ones. decideGate re-checks (shouldGate).
  matcher: ['/', '/index.html', '/((?!api/|assets/|icons/|tools/|login|download)[^.]*)'],
};

export default async function middleware(request: Request): Promise<Response | undefined> {
  const env = process.env;
  const kvUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
  const kvToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';
  const decision = await decideGate(
    {
      url: request.url,
      cookie: request.headers.get('cookie'),
      secFetchMode: request.headers.get('sec-fetch-mode'),
      secFetchDest: request.headers.get('sec-fetch-dest'),
    },
    {
      secret: (env.SIGNING_SECRET ?? '').trim(),
      loadUser: kvUrl && kvToken ? restUserLoader(kvUrl, kvToken) : async () => {
        throw new Error('KV not configured');
      },
    },
  );
  if (decision.action === 'next') return undefined; // continue to the static file
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL(decision.location, request.url).toString(),
      'Cache-Control': 'no-store',
      'X-Gate-Reason': decision.reason,
    },
  });
}
