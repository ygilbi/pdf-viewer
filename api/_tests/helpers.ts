import type { Mailer, MailMessage } from '../_lib/mailer.js';

export const ORIGIN = 'https://app.example.test';

export const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

export const BASE_ENV: Record<string, string> = {
  SIGNING_SECRET: SECRET,
  OWNER_EMAIL: 'owner@example.test',
  SMTP_USER: 'sender@example.test',
  SMTP_PASS: 'app-password',
  GITHUB_TOKEN: 'github_pat_test',
  APP_URL: 'https://app.example.test',
  KV_REST_API_URL: 'https://kv.example.test',
  KV_REST_API_TOKEN: 'kv-token-test',
};

export const ENV_KEYS = [
  ...Object.keys(BASE_ENV),
  'SEND_REQUESTER_ACK',
  'SEND_DENY_EMAIL',
  'GITHUB_REPO',
  'INVITE_HOURS',
  'SESSION_DAYS',
  'RP_ID',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_API_KEY',
  'GOOGLE_PROJECT_NUMBER',
];

export function setEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (v !== undefined) process.env[k] = v;
  }
}

export function fakeMailer(verifyError?: unknown): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(m) {
      sent.push(m);
    },
    async verify() {
      if (verifyError) throw verifyError;
    },
  };
}

/** Tiny cookie jar: collects Set-Cookie headers and replays them as a Cookie header. */
export class CookieJar {
  readonly cookies = new Map<string, string>();
  absorb(res: Response): this {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const maxAge = attrs.map((a) => a.trim()).find((a) => /^max-age=/i.test(a));
      if (value === '' || maxAge === 'Max-Age=0') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export function jsonPost(path: string, body: unknown, jar?: CookieJar, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': freshIp(),
      origin: ORIGIN,
      ...(jar && jar.cookies.size ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function get(path: string, jar?: CookieJar, headers: Record<string, string> = {}): Request {
  return new Request(path.startsWith('http') ? path : `${ORIGIN}${path}`, {
    headers: { 'x-forwarded-for': freshIp(), ...(jar && jar.cookies.size ? { cookie: jar.header() } : {}), ...headers },
  });
}

let ipCounter = 0;
/** Fresh client IP per call so the in-memory rate limiter does not interfere between tests. */
export const freshIp = (): string => `203.0.113.${++ipCounter % 250}`;

/** Extract the href of the first link whose URL contains `path`. */
export function linkTo(html: string, path: string): string {
  const m = html.match(new RegExp(`href="([^"]*${path.replace(/[/?]/g, '\\$&')}[^"]*)"`));
  if (!m) throw new Error(`no link to ${path}`);
  return m[1].replace(/&amp;/g, '&');
}
