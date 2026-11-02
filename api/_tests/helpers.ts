import type { Mailer, MailMessage } from '../_lib/mailer.js';

export const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

export const BASE_ENV: Record<string, string> = {
  SIGNING_SECRET: SECRET,
  OWNER_EMAIL: 'owner@example.test',
  SMTP_USER: 'sender@example.test',
  SMTP_PASS: 'app-password',
  GITHUB_TOKEN: 'github_pat_test',
  APP_URL: 'https://app.example.test',
};

export const ENV_KEYS = [
  ...Object.keys(BASE_ENV),
  'SEND_REQUESTER_ACK',
  'SEND_DENY_EMAIL',
  'DOWNLOAD_LINK_DAYS',
  'GITHUB_REPO',
];

export function setEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (v !== undefined) process.env[k] = v;
  }
}

export function fakeMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(m) {
      sent.push(m);
    },
  };
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
