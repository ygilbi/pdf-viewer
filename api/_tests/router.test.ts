import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GET, POST, ROUTES, routeOf } from '../router.js';

function listRoutes(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return listRoutes(p, `${prefix}${name}/`);
    return name.endsWith('.ts') ? [`${prefix}${name.replace(/\.ts$/, '')}`] : [];
  });
}

describe('api router', () => {
  it('maps every file in api/_routes', () => {
    const files = listRoutes(join(__dirname, '../_routes')).sort();
    expect(Object.keys(ROUTES).sort()).toEqual(files);
  });

  it('registers the email-code, add-passkey and passkey-status routes', () => {
    for (const r of ['auth/email/start', 'auth/email/verify', 'auth/register/email', 'auth/passkey/add/options', 'auth/passkey/add/verify', 'auth/passkey/status']) {
      expect(ROUTES[r]?.POST, r).toBeTypeOf('function');
    }
  });

  it('registers the Google sign-in, providers and invite-status routes (GET)', () => {
    for (const r of ['auth/providers', 'auth/invite-status', 'auth/google/start', 'auth/google/callback']) {
      expect(ROUTES[r]?.GET, r).toBeTypeOf('function');
    }
  });

  it('keeps the deployment under the Hobby 12-function limit', () => {
    const fns = readdirSync(join(__dirname, '..')).filter((n) => n.endsWith('.ts') && !n.startsWith('_'));
    expect(fns).toEqual(['router.ts']);
    const vercel = JSON.parse(readFileSync(join(__dirname, '../../vercel.json'), 'utf8'));
    expect(Object.keys(vercel.functions)).toEqual(['api/router.ts']);
  });

  it('reads the route from the rewrite param or the path', () => {
    expect(routeOf(new URL('https://x/api/router?__route=auth/login/options'))).toBe('auth/login/options');
    expect(routeOf(new URL('https://x/api/health'))).toBe('health');
    expect(routeOf(new URL('https://x/api/router?__route=approve&t=abc'))).toBe('approve');
  });

  it('404s unknown routes and 405s wrong methods', async () => {
    const r1 = await GET(new Request('https://x/api/router?__route=nope'));
    expect(r1.status).toBe(404);
    const r2 = await POST(new Request('https://x/api/router?__route=auth/me', { method: 'POST' }));
    expect(r2.status).toBe(405);
  });

  it('dispatches to the endpoint with a clean URL and preserved query', async () => {
    const res = await GET(new Request('https://x/api/router?__route=download&t=old'));
    // Reached the download handler (not the router's own 404/405): without server config it
    // answers with its config error page; with config it redirects to /login.
    expect([302, 500]).toContain(res.status);
    if (res.status === 302) expect(res.headers.get('location')).toContain('/login');
    else expect(res.headers.get('content-type')).toContain('text/html');
  });
});
