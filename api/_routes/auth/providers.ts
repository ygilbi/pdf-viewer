// GET /api/auth/providers → { ok: true, google: boolean, passkey: true, emailCode: true }
// Which sign-in methods the login page should offer. google = GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set.
import { googleFromEnv } from '../../_lib/config.js';
import { jsonResponse } from '../../_lib/http.js';

export function GET(): Response {
  return jsonResponse({ ok: true, google: googleFromEnv() !== null, passkey: true, emailCode: true });
}
