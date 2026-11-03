// GET /api/auth/providers → { ok: true, google: boolean, passkey: true, emailCode: true,
//   googleClientId?, googlePickerApiKey?, googleAppId? }
// Which sign-in methods the login page should offer. google = GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set.
// Google Drive integration (public values, used in the browser): googleClientId when Google is configured;
// googlePickerApiKey + googleAppId (GOOGLE_API_KEY, GOOGLE_PROJECT_NUMBER) when both are also set.
import { googleFromEnv } from '../../_lib/config.js';
import { jsonResponse } from '../../_lib/http.js';

export function GET(): Response {
  const google = googleFromEnv();
  const apiKey = (process.env.GOOGLE_API_KEY ?? '').trim();
  const projectNumber = (process.env.GOOGLE_PROJECT_NUMBER ?? '').trim();
  const drive = google
    ? {
        googleClientId: google.clientId,
        ...(apiKey && /^\d+$/.test(projectNumber) ? { googlePickerApiKey: apiKey, googleAppId: projectNumber } : {}),
      }
    : {};
  return jsonResponse({ ok: true, google: google !== null, passkey: true, emailCode: true, ...drive });
}
