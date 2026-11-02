// Shared logic for the owner's email actions: /api/approve, /api/deny (approve token) and /api/revoke (revoke token).
// GET only renders a confirmation page (email link scanners prefetch GET URLs); the action happens on POST.
import { getMailer } from './mailer.js';
import { nowSeconds, signToken, verifyToken } from './token.js';
import {
  alreadyActivePage,
  approvedPage,
  confirmPage,
  deniedPage,
  denyEmail,
  errorPage,
  inviteEmail,
  invalidLinkPage,
  revokedPage,
  type DecisionAction,
} from './templates.js';
import { appBaseUrl, configOrError, htmlResponse } from './http.js';
import { randomId } from './auth.js';
import { getStore, normEmail, type Store, type UserRecord } from './store.js';
import type { Config } from './config.js';

const tokenType = (action: DecisionAction) => (action === 'revoke' ? 'revoke' : 'approve');

function readToken(req: Request): string | null {
  return new URL(req.url).searchParams.get('t');
}

const STORE_ERROR_PAGE = () =>
  htmlResponse(errorPage('שגיאת מסד נתונים', 'לא ניתן היה לגשת למסד הנתונים. פתחו את ‎/api/health‏ לאבחון ונסו שוב.'), 502);

export function decisionGet(req: Request, action: DecisionAction): Response {
  const { config, error } = configOrError([], 'html');
  if (error) return error;
  const token = readToken(req);
  const v = verifyToken(token, config.signingSecret, tokenType(action));
  if (!v.ok) return htmlResponse(invalidLinkPage(v.reason, `${appBaseUrl(req, config)}/login`, false), 400);
  return htmlResponse(confirmPage(action, v.payload, `/api/${action}?t=${encodeURIComponent(token!)}`));
}

export async function decisionPost(req: Request, action: DecisionAction): Promise<Response> {
  const { config, error } = configOrError(action === 'approve' ? ['mail', 'kv'] : ['kv'], 'html');
  if (error) return error;
  const v = verifyToken(readToken(req), config.signingSecret, tokenType(action));
  const base = appBaseUrl(req, config);
  if (!v.ok) return htmlResponse(invalidLinkPage(v.reason, `${base}/login`, false), 400);
  const email = normEmail(v.payload.email);
  const name = v.payload.name;
  const store = getStore(config.kv);

  let user: UserRecord | null;
  try {
    user = await store.getUser(email);
  } catch (err) {
    console.error('[access] store error:', err);
    return STORE_ERROR_PAGE();
  }
  const now = nowSeconds();

  try {
    if (action === 'approve') return await approve(config, store, base, user, email, name, now);
    if (action === 'deny') return await deny(config, store, user, email, name, now);
    return await revoke(store, user, email, name, now);
  } catch (err) {
    console.error(`[access] store error during ${action}:`, err);
    return STORE_ERROR_PAGE();
  }
}

function baseUser(user: UserRecord | null, email: string, name: string, now: number): UserRecord {
  return user ?? { id: randomId(32), email, name, status: 'pending', createdAt: now, approvedAt: null };
}

async function approve(config: Config, store: Store, base: string, user: UserRecord | null, email: string, name: string, now: number) {
  if (user?.status === 'active') return htmlResponse(alreadyActivePage(email));
  const jti = randomId(18);
  const ttl = Math.round(config.inviteHours * 3600);
  await store.putInvite(jti, email, ttl);
  await store.putUser({ ...baseUser(user, email, name, now), name: user?.name ?? name, status: 'approved', approvedAt: now });
  const invite = signToken({ t: 'invite', name: user?.name ?? name, email, jti, iat: now, exp: now + ttl }, config.signingSecret);
  const mail = inviteEmail({ name: user?.name ?? name, inviteUrl: `${base}/login?invite=${encodeURIComponent(invite)}`, hours: config.inviteHours });
  try {
    await getMailer(config.mail).send({ to: email, ...mail });
  } catch (err) {
    console.error('[access] failed to send invite email:', err);
    return htmlResponse(errorPage('שליחת המייל נכשלה', 'לא ניתן היה לשלוח את קישור ההרשמה. רעננו את הדף ואשרו שוב, או פתחו ‎/api/health‏ לאבחון.'), 502);
  }
  console.log(`[access] approved ${email}`);
  return htmlResponse(approvedPage(email, config.inviteHours));
}

async function deny(config: Config, store: Store, user: UserRecord | null, email: string, name: string, now: number) {
  if (user?.status === 'active') return htmlResponse(alreadyActivePage(email));
  await store.putUser({ ...baseUser(user, email, name, now), status: 'denied', approvedAt: null });
  let notified = false;
  if (config.sendDenyEmail && config.mail.user && config.mail.pass) {
    try {
      await getMailer(config.mail).send({ to: email, ...denyEmail({ name: user?.name ?? name }) });
      notified = true;
    } catch (err) {
      console.error('[access] failed to send decline email:', err);
    }
  }
  console.log(`[access] denied ${email}`);
  return htmlResponse(deniedPage(email, notified));
}

async function revoke(store: Store, user: UserRecord | null, email: string, name: string, now: number) {
  const removed = await store.deleteUserCreds(email);
  await store.putUser({ ...baseUser(user, email, name, now), status: 'revoked', revokedAt: now, sessionEpoch: (user?.sessionEpoch ?? 0) + 1 });
  console.log(`[access] revoked ${email} (removed ${removed} passkeys)`);
  return htmlResponse(revokedPage(email, removed));
}

/** Owner link that revokes access; included in the "registered" notification. */
export function revokeUrl(base: string, secret: string, name: string, email: string, revokeDays: number): string {
  const now = nowSeconds();
  const t = signToken({ t: 'revoke', name, email, iat: now, exp: now + revokeDays * 86400 }, secret);
  return `${base}/api/revoke?t=${encodeURIComponent(t)}`;
}
