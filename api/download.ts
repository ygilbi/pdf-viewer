// GET /api/download?t=<download token> — verifies the signed link, then 302-redirects to GitHub's
// short-lived signed URL for the newest desktop-v* installer (the file is never proxied through the function).
import { resolveInstallerUrl } from './_lib/github.js';
import { nowSeconds, verifyToken } from './_lib/token.js';
import { errorPage, invalidLinkPage } from './_lib/templates.js';
import { appBaseUrl, clientIp, configOrError, htmlResponse } from './_lib/http.js';

export async function GET(req: Request): Promise<Response> {
  const { config, error } = configOrError(['github'], 'html');
  if (error) return error;
  const v = verifyToken(new URL(req.url).searchParams.get('t'), config.signingSecret, 'download');
  if (!v.ok) {
    console.log(`[download-approval] rejected download link (${v.reason}) ip=${clientIp(req)}`);
    return htmlResponse(invalidLinkPage(v.reason, `${appBaseUrl(req, config)}/download`, true), v.reason === 'expired' ? 410 : 400);
  }

  try {
    const { url, tag, assetName } = await resolveInstallerUrl(config.githubRepo, config.githubToken);
    const expiresIn = Math.max(0, Math.round((v.payload.exp - nowSeconds()) / 3600));
    console.log(
      `[download-approval] download email=${v.payload.email} asset=${assetName} tag=${tag} ip=${clientIp(req)} linkExpiresInHours=${expiresIn}`,
    );
    return new Response(null, {
      status: 302,
      headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  } catch (err) {
    console.error('[download-approval] could not resolve installer:', err);
    return htmlResponse(errorPage('ההורדה אינה זמינה כרגע', 'לא ניתן היה להכין את קובץ ההתקנה. נסו שוב בעוד כמה דקות.'), 502);
  }
}
