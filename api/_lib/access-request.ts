// Shared "request access" logic: POST /api/auth/request (public form) and "Sign in with Google" for users who
// are not approved yet. Marks user:{email} 'pending' and emails the owner signed approve/deny links.
import type { Config } from './config.js';
import { getMailer } from './mailer.js';
import { APPROVE_TTL_DAYS, daysFromNow, nowSeconds, signToken } from './token.js';
import { ownerRequestEmail, requesterAckEmail } from './templates.js';
import { appBaseUrl } from './http.js';
import { randomId } from './auth.js';
import { normEmail, type Store, type UserRecord } from './store.js';
import type { AccessRequest } from './validate.js';

export class AccessRequestError extends Error {
  constructor(readonly code: 'store_failed' | 'mail_failed') {
    super(code);
    this.name = 'AccessRequestError';
  }
}

export interface SubmitOptions {
  /** Request came from "Sign in with Google" (shown in the owner's email). */
  via?: 'google';
  /** Skip the owner email when the user is already 'pending' and was requested less than this many seconds ago. */
  dedupeSeconds?: number;
  /** Extra fields to store on the user record (e.g. googleSub). */
  extra?: Partial<Pick<UserRecord, 'googleSub'>>;
}

/** 'already_active': nothing done. 'already_pending': deduplicated, no email. 'sent': owner emailed. */
export type SubmitStatus = 'already_active' | 'already_pending' | 'sent';

/** Throws AccessRequestError('store_failed' | 'mail_failed'). */
export async function submitAccessRequest(
  req: Request,
  config: Config,
  store: Store,
  value: AccessRequest,
  opts: SubmitOptions = {},
): Promise<SubmitStatus> {
  const email = normEmail(value.email);
  const now = nowSeconds();
  let user: UserRecord;
  try {
    const existing = await store.getUser(email);
    if (existing?.status === 'active') return 'already_active';
    if (
      opts.dedupeSeconds &&
      existing?.status === 'pending' &&
      typeof existing.requestedAt === 'number' &&
      now - existing.requestedAt < opts.dedupeSeconds
    ) {
      return 'already_pending';
    }
    user = {
      ...existing,
      ...opts.extra,
      id: existing?.id ?? randomId(32),
      email,
      name: value.name,
      status: 'pending',
      createdAt: existing?.createdAt ?? now,
      approvedAt: null,
      requestedAt: existing?.requestedAt ?? null,
    };
    await store.putUser(user);
  } catch (err) {
    console.error('[access] store error on request:', err);
    throw new AccessRequestError('store_failed');
  }

  const token = signToken({ t: 'approve', ...value, email, iat: now, exp: daysFromNow(APPROVE_TTL_DAYS, now) }, config.signingSecret);
  const base = appBaseUrl(req, config);
  const q = `t=${encodeURIComponent(token)}`;
  const mail = ownerRequestEmail({ ...value, email, approveUrl: `${base}/api/approve?${q}`, denyUrl: `${base}/api/deny?${q}`, via: opts.via });

  const mailer = getMailer(config.mail);
  try {
    await mailer.send({ to: config.ownerEmail, replyTo: email, ...mail });
  } catch (err) {
    console.error('[access] failed to email owner:', err);
    throw new AccessRequestError('mail_failed');
  }
  try {
    // Recorded only after the owner mail went out, so a failed send never suppresses a retry.
    await store.putUser({ ...user, requestedAt: now });
  } catch (err) {
    console.warn('[access] could not record requestedAt:', err);
  }

  if (config.sendRequesterAck) {
    try {
      await mailer.send({ to: email, ...requesterAckEmail() });
    } catch (err) {
      // The owner already has the request; a failed acknowledgement is not fatal.
      console.warn('[access] failed to send requester acknowledgement:', err);
    }
  }
  return 'sent';
}
