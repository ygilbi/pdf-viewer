// Validation of the one-time registration invite used by api/auth/register/*.
import { verifyToken, type InvitePayload } from './token.js';
import type { AuthErrorCode } from './auth.js';
import type { Store, UserRecord } from './store.js';

export type InviteCheck =
  | { ok: true; invite: InvitePayload; user: UserRecord }
  | { ok: false; code: AuthErrorCode };

/** Signature + expiry + jti still unused + user still 'approved'. */
export async function checkInvite(token: unknown, secret: string, store: Store): Promise<InviteCheck> {
  if (typeof token !== 'string') return { ok: false, code: 'invite_invalid' };
  const v = verifyToken(token, secret, 'invite');
  if (!v.ok) return { ok: false, code: v.reason === 'expired' ? 'invite_expired' : 'invite_invalid' };
  if (typeof v.payload.jti !== 'string' || !v.payload.jti) return { ok: false, code: 'invite_invalid' };
  if (!(await store.inviteExists(v.payload.jti))) return { ok: false, code: 'invite_used' };
  const user = await store.getUser(v.payload.email);
  if (!user) return { ok: false, code: 'not_approved' };
  if (user.status === 'active') return { ok: false, code: 'invite_used' };
  if (user.status !== 'approved') return { ok: false, code: 'not_approved' };
  return { ok: true, invite: v.payload, user };
}
