// Shared logic for /api/approve and /api/deny.
// GET only renders a confirmation page (email link scanners prefetch GET URLs); the action happens on POST.
import { getMailer } from './mailer.js';
import { daysFromNow, nowSeconds, signToken, verifyToken } from './token.js';
import { approvedPage, confirmPage, deniedPage, denyEmail, downloadEmail, errorPage, invalidLinkPage } from './templates.js';
import { appBaseUrl, configOrError, htmlResponse } from './http.js';

type Action = 'approve' | 'deny';

function readToken(req: Request): string | null {
  return new URL(req.url).searchParams.get('t');
}

export function decisionGet(req: Request, action: Action): Response {
  const { config, error } = configOrError([], 'html');
  if (error) return error;
  const token = readToken(req);
  const v = verifyToken(token, config.signingSecret, 'approve');
  const base = appBaseUrl(req, config);
  if (!v.ok) return htmlResponse(invalidLinkPage(v.reason, `${base}/download`, false), 400);
  const postUrl = `/api/${action}?t=${encodeURIComponent(token!)}`;
  return htmlResponse(confirmPage(action, v.payload, postUrl));
}

export async function decisionPost(req: Request, action: Action): Promise<Response> {
  const { config, error } = configOrError(['mail'], 'html');
  if (error) return error;
  const v = verifyToken(readToken(req), config.signingSecret, 'approve');
  const base = appBaseUrl(req, config);
  if (!v.ok) return htmlResponse(invalidLinkPage(v.reason, `${base}/download`, false), 400);
  const { name, email } = v.payload;
  const mailer = getMailer(config.mail);

  if (action === 'approve') {
    const iat = nowSeconds();
    const dl = signToken(
      { t: 'download', name, email, iat, exp: daysFromNow(config.downloadLinkDays, iat) },
      config.signingSecret,
    );
    const mail = downloadEmail({
      name,
      downloadUrl: `${base}/api/download?t=${encodeURIComponent(dl)}`,
      days: config.downloadLinkDays,
    });
    try {
      await mailer.send({ to: email, ...mail });
    } catch (err) {
      console.error('[download-approval] failed to send download email:', err);
      return htmlResponse(errorPage('שליחת המייל נכשלה', 'לא ניתן היה לשלוח את קישור ההורדה. נסו לרענן ולאשר שוב.'), 502);
    }
    console.log(`[download-approval] approved ${email}`);
    return htmlResponse(approvedPage(email, config.downloadLinkDays));
  }

  let notified = false;
  if (config.sendDenyEmail) {
    try {
      await mailer.send({ to: email, ...denyEmail({ name }) });
      notified = true;
    } catch (err) {
      console.error('[download-approval] failed to send decline email:', err);
    }
  }
  console.log(`[download-approval] denied ${email}`);
  return htmlResponse(deniedPage(email, notified));
}
