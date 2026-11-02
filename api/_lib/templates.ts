// Hebrew RTL HTML pages and emails. All user-supplied values pass through esc() before reaching HTML.

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape and keep line breaks (for the free-text message). */
const escMultiline = (value: string): string => esc(value).replace(/\r?\n/g, '<br>');

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const FONT = "font-family:Arial,'Segoe UI',Helvetica,sans-serif";

// ---------------------------------------------------------------- pages (served to a browser)

export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f7; --card:#fff; --fg:#1f2328; --muted:#5b6470; --line:#d9dde3; --accent:#2563eb; --danger:#c62828; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --card:#1d2026; --fg:#e8eaed; --muted:#a0a7b1; --line:#30343b; --accent:#5b8def; --danger:#ef5350; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); ${FONT}; line-height:1.6; }
  main { max-width:560px; margin:48px auto; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
  h1 { font-size:1.4rem; margin:0 0 12px; }
  p { margin:0 0 12px; }
  .muted { color:var(--muted); font-size:.92rem; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 16px; margin:16px 0; }
  dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
  .btn { display:inline-block; border:0; border-radius:8px; padding:12px 22px; font-size:1rem; font-weight:700; color:#fff; background:var(--accent); cursor:pointer; text-decoration:none; ${FONT}; }
  .btn.danger { background:var(--danger); }
  form { margin-top:20px; }
  a { color:var(--accent); }
</style>
</head>
<body><main><div class="card">${bodyHtml}</div></main></body>
</html>`;
}

function detailsList(d: { name: string; email: string; company?: string; message?: string }): string {
  return `<dl>
  <dt>שם</dt><dd>${esc(d.name)}</dd>
  <dt>אימייל</dt><dd dir="ltr" style="text-align:right">${esc(d.email)}</dd>
  ${d.company ? `<dt>חברה</dt><dd>${esc(d.company)}</dd>` : ''}
  ${d.message ? `<dt>הודעה</dt><dd>${escMultiline(d.message)}</dd>` : ''}
</dl>`;
}

export function confirmPage(
  action: 'approve' | 'deny',
  d: { name: string; email: string; company?: string; message?: string },
  postUrl: string,
): string {
  const approve = action === 'approve';
  const title = approve ? 'אישור בקשת הורדה' : 'דחיית בקשת הורדה';
  return page(
    title,
    `<h1>${title}</h1>
<p>${approve ? 'לאשר את הבקשה ולשלוח קישור הורדה אל המבקש?' : 'לדחות את בקשת ההורדה?'}</p>
${detailsList(d)}
<form method="post" action="${esc(postUrl)}">
  <button class="btn${approve ? '' : ' danger'}" type="submit">${approve ? 'אשר ושלח קישור הורדה' : 'דחה בקשה'}</button>
</form>
<p class="muted" style="margin-top:16px">שום פעולה לא מתבצעת עד שתלחצו על הכפתור.</p>`,
  );
}

export function approvedPage(email: string, days: number): string {
  return page(
    'ההורדה אושרה',
    `<h1>ההורדה אושרה</h1>
<p>נשלח מייל אל <strong dir="ltr">${esc(email)}</strong> עם קישור הורדה.</p>
<p class="muted">הקישור תקף ל-${esc(days)} ימים.</p>`,
  );
}

export function deniedPage(email: string, notified: boolean): string {
  return page(
    'הבקשה נדחתה',
    `<h1>הבקשה נדחתה</h1>
<p>הבקשה של <strong dir="ltr">${esc(email)}</strong> נדחתה.</p>
<p class="muted">${notified ? 'נשלחה למבקש הודעת דחייה.' : 'לא נשלחה הודעה למבקש.'}</p>`,
  );
}

const REASON_TEXT: Record<string, string> = {
  expired: 'תוקף הקישור פג.',
  signature: 'הקישור אינו תקין (ייתכן שהועתק חלקית או שונה).',
  malformed: 'הקישור אינו תקין (ייתכן שהועתק חלקית).',
  type: 'הקישור אינו מתאים לפעולה זו.',
};

export function invalidLinkPage(reason: string, requestUrl: string, forRequester: boolean): string {
  return page(
    'הקישור אינו תקף',
    `<h1>הקישור אינו תקף</h1>
<p>${esc(REASON_TEXT[reason] ?? REASON_TEXT.malformed)}</p>
${
  forRequester
    ? `<p>ניתן לשלוח בקשת הורדה חדשה:</p><p><a class="btn" href="${esc(requestUrl)}">בקשת הורדה חדשה</a></p>`
    : `<p class="muted">אם המבקש עדיין מעוניין, הוא יכול לשלוח בקשה חדשה בכתובת <a href="${esc(requestUrl)}">${esc(requestUrl)}</a>.</p>`
}`,
  );
}

export function errorPage(title: string, message: string): string {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}

// ---------------------------------------------------------------- emails

function emailShell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body dir="rtl" style="margin:0;padding:0;background:#f4f5f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="max-width:560px;background:#ffffff;border:1px solid #d9dde3;border-radius:12px">
<tr><td dir="rtl" style="padding:28px;text-align:right;${FONT};font-size:16px;line-height:1.6;color:#1f2328">
${inner}
</td></tr></table>
<p style="${FONT};font-size:12px;color:#8a929c;margin:16px 0 0">PDF Viewer</p>
</td></tr></table>
</body></html>`;
}

function button(href: string, label: string, color: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:bold;font-size:17px;padding:14px 28px;border-radius:8px;${FONT}">${esc(label)}</a>`;
}

function row(label: string, valueHtml: string): string {
  return `<tr><td style="padding:4px 0 4px 16px;color:#5b6470;vertical-align:top;white-space:nowrap">${label}</td><td style="padding:4px 0;vertical-align:top">${valueHtml}</td></tr>`;
}

export function ownerRequestEmail(d: {
  name: string;
  email: string;
  company?: string;
  message?: string;
  approveUrl: string;
  denyUrl: string;
  ip?: string;
}): Rendered {
  const html = emailShell(
    'בקשת הורדה חדשה',
    `<h1 style="font-size:20px;margin:0 0 12px">בקשת הורדה חדשה ל-PDF Viewer</h1>
<p style="margin:0 0 12px">התקבלה בקשה להורדת תוכנת ההתקנה ל-Windows:</p>
<table role="presentation" cellpadding="0" cellspacing="0" dir="rtl" style="margin:0 0 20px;${FONT};font-size:15px">
${row('שם', esc(d.name))}
${row('אימייל', `<span dir="ltr">${esc(d.email)}</span>`)}
${d.company ? row('חברה', esc(d.company)) : ''}
${d.message ? row('הודעה', escMultiline(d.message)) : ''}
</table>
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding:0 0 0 12px">${button(d.approveUrl, 'אשר הורדה', '#16a34a')}</td>
<td>${button(d.denyUrl, 'דחה', '#c62828')}</td>
</tr></table>
<p style="margin:20px 0 0;font-size:13px;color:#5b6470">לחיצה על כפתור פותחת דף אישור — הפעולה מתבצעת רק לאחר לחיצה נוספת בדף. הקישורים תקפים ל-14 ימים.</p>`,
  );
  const text = [
    'בקשת הורדה חדשה ל-PDF Viewer',
    '',
    `שם: ${d.name}`,
    `אימייל: ${d.email}`,
    d.company ? `חברה: ${d.company}` : '',
    d.message ? `הודעה:\n${d.message}` : '',
    '',
    `אשר הורדה: ${d.approveUrl}`,
    '',
    `דחה: ${d.denyUrl}`,
    '',
    'הקישורים פותחים דף אישור; הפעולה מתבצעת רק לאחר לחיצה נוספת. תקפים ל-14 ימים.',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  return { subject: `בקשת הורדה ל-PDF Viewer: ${d.name}`, html, text };
}

/** Sent to an address typed into a public form, so it deliberately contains no user-supplied text. */
export function requesterAckEmail(): Rendered {
  return {
    subject: 'הבקשה להורדת PDF Viewer התקבלה',
    html: emailShell(
      'הבקשה התקבלה',
      `<h1 style="font-size:20px;margin:0 0 12px">הבקשה התקבלה וממתינה לאישור</h1>
<p style="margin:0 0 12px">תודה על הפנייה. לאחר אישור הבקשה יישלח אליכם מייל עם קישור להורדת PDF Viewer ל-Windows.</p>
<p style="margin:0;font-size:13px;color:#5b6470">אם לא אתם ביקשתם — אפשר להתעלם מהודעה זו.</p>`,
    ),
    text:
      'הבקשה התקבלה וממתינה לאישור.\n\nלאחר אישור הבקשה יישלח אליכם מייל עם קישור להורדת PDF Viewer ל-Windows.\n\nאם לא אתם ביקשתם — אפשר להתעלם מהודעה זו.',
  };
}

export function downloadEmail(d: { name: string; downloadUrl: string; days: number }): Rendered {
  const html = emailShell(
    'ההורדה אושרה',
    `<h1 style="font-size:20px;margin:0 0 12px">שלום ${esc(d.name)},</h1>
<p style="margin:0 0 20px">הבקשה שלך אושרה. אפשר להוריד את תוכנת ההתקנה של PDF Viewer ל-Windows:</p>
<p style="margin:0 0 24px">${button(d.downloadUrl, 'הורד את PDF Viewer ל-Windows', '#2563eb')}</p>
<h2 style="font-size:17px;margin:0 0 8px">הוראות התקנה</h2>
<ol style="margin:0 0 16px;padding-right:20px;padding-left:0">
<li style="margin-bottom:6px">הריצו את הקובץ שהורד (<span dir="ltr">PDF-Viewer-Setup-….exe</span>).</li>
<li style="margin-bottom:6px">אם מופיע חלון כחול של Windows SmartScreen („Windows הגן על המחשב שלך”): לחצו על <strong>מידע נוסף</strong> (More info) ואז על <strong>הפעל בכל זאת</strong> (Run anyway).</li>
<li style="margin-bottom:6px">בסיום ההתקנה ייפתח דף „אפליקציות ברירת מחדל” של Windows — שם אפשר לבחור ב-PDF Viewer כתוכנה לפתיחת קובצי PDF.</li>
</ol>
<p style="margin:0;font-size:13px;color:#5b6470">הקישור תקף ל-${esc(d.days)} ימים ומיועד לך בלבד. אם פג תוקפו, אפשר לשלוח בקשה חדשה.</p>`,
  );
  const text = [
    `שלום ${d.name},`,
    '',
    'הבקשה שלך אושרה. להורדת PDF Viewer ל-Windows:',
    d.downloadUrl,
    '',
    'הוראות התקנה:',
    '1. הריצו את הקובץ שהורד (PDF-Viewer-Setup-….exe).',
    '2. אם מופיע חלון Windows SmartScreen: לחצו "מידע נוסף" (More info) ואז "הפעל בכל זאת" (Run anyway).',
    '3. בסיום ההתקנה ייפתח דף "אפליקציות ברירת מחדל" של Windows — שם אפשר לבחור ב-PDF Viewer לפתיחת קובצי PDF.',
    '',
    `הקישור תקף ל-${d.days} ימים ומיועד לך בלבד.`,
  ].join('\n');
  return { subject: 'הורדת PDF Viewer ל-Windows אושרה', html, text };
}

export function denyEmail(d: { name: string }): Rendered {
  return {
    subject: 'בקשת ההורדה של PDF Viewer',
    html: emailShell(
      'בקשת ההורדה',
      `<h1 style="font-size:20px;margin:0 0 12px">שלום ${esc(d.name)},</h1>
<p style="margin:0">תודה על ההתעניינות ב-PDF Viewer. לצערנו לא נוכל לאשר את בקשת ההורדה בשלב זה.</p>`,
    ),
    text: `שלום ${d.name},\n\nתודה על ההתעניינות ב-PDF Viewer. לצערנו לא נוכל לאשר את בקשת ההורדה בשלב זה.`,
  };
}
