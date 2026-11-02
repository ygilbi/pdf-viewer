// GET /api/health — configuration diagnostics for the site owner. Reports only booleans and short status
// strings; never any secret value. env.google = Google sign-in configured (optional). Checks: env vars present, SMTP login (transporter.verify, 8 s timeout),
// Redis reachability, GitHub release listing. Open it after every change of environment variables.
import { MIN_SECRET_LENGTH, googleFromEnv, kvFromEnv, type MailConfig } from '../_lib/config.js';
import { describeSmtpError, getMailer } from '../_lib/mailer.js';
import { checkGitHub } from '../_lib/github.js';
import { clientIp, createRateLimiter, isLocalHost, jsonResponse, requestHost } from '../_lib/http.js';
import { getStore, hasStoreOverride } from '../_lib/store.js';

const limiter = createRateLimiter(10, 60 * 1000);
const TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT_HEALTH' })), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

const s = (v: string | undefined) => (v ?? '').trim();

export async function GET(req: Request): Promise<Response> {
  if (!limiter.hit(clientIp(req))) {
    return jsonResponse({ ok: false, code: 'rate_limited', error: 'יותר מדי בדיקות. נסו שוב בעוד דקה.' }, 429, { 'Retry-After': '60' });
  }
  const env = process.env;
  const kv = kvFromEnv(env);
  const secret = s(env.SIGNING_SECRET);
  const envReport = {
    OWNER_EMAIL: !!s(env.OWNER_EMAIL),
    SMTP_USER: !!s(env.SMTP_USER),
    SMTP_PASS: !!s(env.SMTP_PASS),
    SIGNING_SECRET: secret.length >= MIN_SECRET_LENGTH,
    GITHUB_TOKEN: !!s(env.GITHUB_TOKEN),
    KV: !!kv,
  };
  // Optional feature ("Sign in with Google"): reported, but does not affect `ok`.
  const google = googleFromEnv(env) !== null;

  const smtpCheck = async (): Promise<string> => {
    if (!envReport.SMTP_USER || !envReport.SMTP_PASS) return 'skipped';
    const port = Number(s(env.SMTP_PORT) || 465);
    const mail: MailConfig = {
      host: s(env.SMTP_HOST) || 'smtp.gmail.com',
      port,
      secure: s(env.SMTP_SECURE) ? /^(true|1|yes)$/i.test(s(env.SMTP_SECURE)) : port === 465,
      user: s(env.SMTP_USER),
      pass: s(env.SMTP_PASS),
      from: s(env.MAIL_FROM) || s(env.SMTP_USER),
    };
    const mailer = getMailer(mail);
    if (!mailer.verify) return 'skipped';
    try {
      await withTimeout(mailer.verify());
      return 'ok';
    } catch (err) {
      return `error: ${describeSmtpError(err)}`;
    }
  };

  const redisCheck = async (): Promise<string> => {
    if (!kv && !hasStoreOverride()) return 'missing';
    try {
      const store = getStore(kv ?? { url: '', token: '' }); // test override when kv is null
      await withTimeout(store.ping());
      return 'ok';
    } catch {
      return 'error';
    }
  };

  const githubCheck = async (): Promise<{ status: string; installer: string | null }> => {
    if (!envReport.GITHUB_TOKEN) return { status: 'missing', installer: null };
    return checkGitHub(s(env.GITHUB_REPO) || 'ygilbi/pdf-viewer', s(env.GITHUB_TOKEN));
  };

  const [smtp, redis, gh] = await Promise.all([smtpCheck(), redisCheck(), githubCheck()]);

  const appUrl = s(env.APP_URL).replace(/\/+$/, '');
  let rpId = s(env.RP_ID).toLowerCase();
  if (!rpId && appUrl) {
    try {
      rpId = new URL(appUrl).hostname;
    } catch {
      rpId = '(APP_URL invalid)';
    }
  }
  if (!rpId) rpId = requestHost(req);

  const ok = Object.values(envReport).every(Boolean) && smtp === 'ok' && redis === 'ok' && gh.status === 'ok';
  return jsonResponse({
    ok,
    env: { ...envReport, google },
    smtp,
    redis,
    github: gh.status,
    installer: gh.installer,
    rpId,
    rpIdMatchesHost: rpId === requestHost(req) || isLocalHost(requestHost(req)),
  });
}
