// GET /api/download — requires a valid passkey session (pv_session cookie, user 'active').
// Not signed in → 302 /login?next=/api/download. Signed in → 302 to GitHub's short-lived signed URL for the
// newest desktop-v* installer (the file is never proxied through the function).
// The old emailed ?t=<download token> links are no longer accepted (they also just redirect to /login).
import { resolveInstallerUrl } from './_lib/github.js';
import { errorPage } from './_lib/templates.js';
import { clientIp, configOrError, htmlResponse } from './_lib/http.js';
import { currentUser } from './_lib/auth.js';
import { getStore } from './_lib/store.js';

export const LOGIN_FOR_DOWNLOAD = '/login?next=%2Fapi%2Fdownload';

export async function GET(req: Request): Promise<Response> {
  const { config, error } = configOrError(['github', 'kv'], 'html');
  if (error) return error;

  let email: string;
  try {
    const user = await currentUser(req, config, getStore(config.kv));
    if (!user) {
      return new Response(null, { status: 302, headers: { Location: LOGIN_FOR_DOWNLOAD, 'Cache-Control': 'no-store' } });
    }
    email = user.email;
  } catch (err) {
    console.error('[access] download: store error:', err);
    return htmlResponse(errorPage('שגיאת מסד נתונים', 'לא ניתן היה לאמת את ההתחברות. נסו שוב בעוד כמה דקות.'), 502);
  }

  try {
    const { url, tag, assetName } = await resolveInstallerUrl(config.githubRepo, config.githubToken);
    console.log(`[access] download email=${email} asset=${assetName} tag=${tag} ip=${clientIp(req)}`);
    return new Response(null, {
      status: 302,
      headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  } catch (err) {
    console.error('[access] could not resolve installer:', err);
    return htmlResponse(errorPage('ההורדה אינה זמינה כרגע', 'לא ניתן היה להכין את קובץ ההתקנה. נסו שוב בעוד כמה דקות.'), 502);
  }
}
