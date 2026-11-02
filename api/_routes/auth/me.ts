// GET /api/auth/me → { ok: true, user: { name, email }, hasPasskey } or 401 { ok: false, code: 'unauthenticated' }.
// A session is valid only while user:{email} is still 'active' (so revocation takes effect immediately).
// hasPasskey = the user has at least one registered passkey (false for users who registered with an email code).
import { authError, currentUser, hasPasskey, publicUser } from '../../_lib/auth.js';
import { configOrError, jsonResponse } from '../../_lib/http.js';
import { getStore } from '../../_lib/store.js';

export async function GET(req: Request): Promise<Response> {
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  try {
    const store = getStore(config.kv);
    const user = await currentUser(req, config, store);
    if (!user) return authError('unauthenticated');
    return jsonResponse({ ok: true, user: publicUser(user), hasPasskey: await hasPasskey(store, user.email) });
  } catch (err) {
    console.error('[access] /me store error:', err);
    return authError('store_failed');
  }
}
