// GET /api/auth/me → { ok: true, user: { name, email } } or 401 { ok: false, code: 'unauthenticated' }.
// A session is valid only while user:{email} is still 'active' (so revocation takes effect immediately).
import { authError, currentUser, publicUser } from '../_lib/auth.js';
import { configOrError, jsonResponse } from '../_lib/http.js';
import { getStore } from '../_lib/store.js';

export async function GET(req: Request): Promise<Response> {
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  try {
    const user = await currentUser(req, config, getStore(config.kv));
    if (!user) return authError('unauthenticated');
    return jsonResponse({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error('[access] /me store error:', err);
    return authError('store_failed');
  }
}
