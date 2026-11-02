// Environment configuration for the download-approval functions.
// Every value comes from Vercel → Project → Settings → Environment Variables (see docs/download-approval-setup.md).
// Nothing secret lives in the repo; missing required values fail closed with a clear, logged error.

export type Env = Record<string, string | undefined>;

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface Config {
  signingSecret: string;
  ownerEmail: string;
  appUrl: string | null;
  downloadLinkDays: number;
  sendRequesterAck: boolean;
  sendDenyEmail: boolean;
  githubRepo: string;
  githubToken: string;
  mail: MailConfig;
}

/** What a given endpoint needs. Only the listed groups are required to be present. */
export type Need = 'mail' | 'owner' | 'github';

export class ConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing or invalid environment variables: ${missing.join(', ')}`);
    this.name = 'ConfigError';
  }
}

export const MIN_SECRET_LENGTH = 32;

function str(env: Env, key: string): string {
  return (env[key] ?? '').trim();
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = str(env, key).toLowerCase();
  if (!v) return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Load configuration. SIGNING_SECRET is always required; `needs` adds the groups an endpoint uses:
 *  - mail:   SMTP_USER, SMTP_PASS (SMTP_HOST / SMTP_PORT / MAIL_FROM have defaults)
 *  - owner:  OWNER_EMAIL
 *  - github: GITHUB_TOKEN (GITHUB_REPO defaults to ygilbi/pdf-viewer)
 * Throws ConfigError naming every missing variable (names only, never values).
 */
export function loadConfig(needs: Need[], env: Env = process.env): Config {
  const missing: string[] = [];
  const signingSecret = str(env, 'SIGNING_SECRET');
  if (signingSecret.length < MIN_SECRET_LENGTH) missing.push(`SIGNING_SECRET (min ${MIN_SECRET_LENGTH} chars)`);

  const ownerEmail = str(env, 'OWNER_EMAIL');
  if (needs.includes('owner') && !ownerEmail) missing.push('OWNER_EMAIL');

  const user = str(env, 'SMTP_USER');
  const pass = str(env, 'SMTP_PASS');
  if (needs.includes('mail')) {
    if (!user) missing.push('SMTP_USER');
    if (!pass) missing.push('SMTP_PASS');
  }

  const githubToken = str(env, 'GITHUB_TOKEN');
  if (needs.includes('github') && !githubToken) missing.push('GITHUB_TOKEN');

  const port = Number(str(env, 'SMTP_PORT') || 465);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) missing.push('SMTP_PORT (invalid)');

  const daysRaw = str(env, 'DOWNLOAD_LINK_DAYS');
  const downloadLinkDays = daysRaw ? Number(daysRaw) : 3;
  if (!Number.isFinite(downloadLinkDays) || downloadLinkDays <= 0 || downloadLinkDays > 60) {
    missing.push('DOWNLOAD_LINK_DAYS (must be 1–60)');
  }

  const appUrlRaw = str(env, 'APP_URL').replace(/\/+$/, '');
  let appUrl: string | null = null;
  if (appUrlRaw) {
    if (/^https?:\/\/[^\s/]+$/i.test(appUrlRaw)) appUrl = appUrlRaw;
    else missing.push('APP_URL (must be like https://example.com, no path)');
  }

  const githubRepo = str(env, 'GITHUB_REPO') || 'ygilbi/pdf-viewer';
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) missing.push('GITHUB_REPO (must be owner/repo)');

  if (missing.length) throw new ConfigError(missing);

  const secureRaw = str(env, 'SMTP_SECURE');
  return {
    signingSecret,
    ownerEmail,
    appUrl,
    downloadLinkDays,
    sendRequesterAck: bool(env, 'SEND_REQUESTER_ACK', true),
    sendDenyEmail: bool(env, 'SEND_DENY_EMAIL', false),
    githubRepo,
    githubToken,
    mail: {
      host: str(env, 'SMTP_HOST') || 'smtp.gmail.com',
      port,
      secure: secureRaw ? bool(env, 'SMTP_SECURE', true) : port === 465,
      user,
      pass,
      from: str(env, 'MAIL_FROM') || `"PDF Viewer" <${user}>`,
    },
  };
}
