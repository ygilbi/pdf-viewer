// Environment configuration for the access (request → approve → passkey) functions.
// Every value comes from Vercel → Project → Settings → Environment Variables (see docs/access-setup.md).
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

export interface KvConfig {
  url: string;
  token: string;
}

export interface Config {
  signingSecret: string;
  ownerEmail: string;
  appUrl: string | null;
  /** WebAuthn Relying Party ID override (RP_ID); null = hostname of APP_URL, else the request host. */
  rpId: string | null;
  inviteHours: number;
  sessionDays: number;
  sendRequesterAck: boolean;
  sendDenyEmail: boolean;
  githubRepo: string;
  githubToken: string;
  mail: MailConfig;
  kv: KvConfig;
}

/** What a given endpoint needs. Only the listed groups are required to be present. */
export type Need = 'mail' | 'owner' | 'github' | 'kv';

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

/** Upstash Redis REST credentials: Vercel's Upstash integration injects KV_REST_API_*; UPSTASH_REDIS_REST_* also work. */
export function kvFromEnv(env: Env = process.env): KvConfig | null {
  const url = str(env, 'KV_REST_API_URL') || str(env, 'UPSTASH_REDIS_REST_URL');
  const token = str(env, 'KV_REST_API_TOKEN') || str(env, 'UPSTASH_REDIS_REST_TOKEN');
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

function num(env: Env, key: string, fallback: number, min: number, max: number, missing: string[]): number {
  const raw = str(env, key);
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n) || n < min || n > max) {
    missing.push(`${key} (must be ${min}–${max})`);
    return fallback;
  }
  return n;
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
 *  - kv:     KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
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

  const kv = kvFromEnv(env);
  if (needs.includes('kv') && !kv) missing.push('KV_REST_API_URL + KV_REST_API_TOKEN (Upstash Redis)');

  const inviteHours = num(env, 'INVITE_HOURS', 72, 1, 24 * 30, missing);
  const sessionDays = num(env, 'SESSION_DAYS', 30, 1, 365, missing);

  const rpIdRaw = str(env, 'RP_ID').toLowerCase();
  let rpId: string | null = null;
  if (rpIdRaw) {
    if (/^[a-z0-9.-]+$/.test(rpIdRaw)) rpId = rpIdRaw;
    else missing.push('RP_ID (must be a bare hostname, e.g. pdf-viewer-lemon.vercel.app)');
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
    rpId,
    inviteHours,
    sessionDays,
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
    kv: kv ?? { url: '', token: '' },
  };
}
