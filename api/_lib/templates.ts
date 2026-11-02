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

export type DecisionAction = 'approve' | 'deny' | 'revoke';

const CONFIRM: Record<DecisionAction, { title: string; question: string; button: string; danger: boolean }> = {
  approve: {
    title: 'אישור בקשת גישה',
    question: 'לאשר את הבקשה? המבקש/ת יקבלו במייל קישור הרשמה חד-פעמי (עם טביעת אצבע / זיהוי פנים / Windows Hello, או עם קוד במייל).',
    button: 'אשר ושלח קישור הרשמה',
    danger: false,
  },
  deny: { title: 'דחיית בקשת גישה', question: 'לדחות את בקשת הגישה?', button: 'דחה בקשה', danger: true },
  revoke: {
    title: 'ביטול גישה',
    question: 'לבטל את הגישה של המשתמש/ת? כל מפתחות הגישה שלו/ה יימחקו וההתחברות תיחסם מיד.',
    button: 'בטל גישה',
    danger: true,
  },
};

export function confirmPage(
  action: DecisionAction,
  d: { name: string; email: string; company?: string; message?: string },
  postUrl: string,
): string {
  const c = CONFIRM[action];
  return page(
    c.title,
    `<h1>${c.title}</h1>
<p>${c.question}</p>
${detailsList(d)}
<form method="post" action="${esc(postUrl)}">
  <button class="btn${c.danger ? ' danger' : ''}" type="submit">${c.button}</button>
</form>
<p class="muted" style="margin-top:16px">שום פעולה לא מתבצעת עד שתלחצו על הכפתור.</p>`,
  );
}

export function approvedPage(email: string, hours: number): string {
  return page(
    'הגישה אושרה',
    `<h1>הגישה אושרה</h1>
<p>נשלח מייל אל <strong dir="ltr">${esc(email)}</strong> עם קישור הרשמה חד-פעמי.</p>
<p class="muted">הקישור תקף ל-${esc(hours)} שעות. כשההרשמה תושלם יישלח אליכם מייל עם אפשרות לבטל את הגישה.</p>`,
  );
}

export function alreadyActivePage(email: string): string {
  return page(
    'המשתמש/ת כבר רשום/ה',
    `<h1>המשתמש/ת כבר רשום/ה</h1>
<p><strong dir="ltr">${esc(email)}</strong> כבר השלים/ה הרשמה ויכול/ה להתחבר (עם מפתח גישה או עם קוד במייל). לא נשלח מייל נוסף.</p>`,
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

export function revokedPage(email: string, removed: number): string {
  return page(
    'הגישה בוטלה',
    `<h1>הגישה בוטלה</h1>
<p>הגישה של <strong dir="ltr">${esc(email)}</strong> בוטלה. ${esc(removed)} מפתחות גישה נמחקו, וההתחברויות הפעילות נחסמו.</p>
<p class="muted">אם תרצו לאפשר גישה שוב — המשתמש/ת יכולים לשלוח בקשה חדשה ותקבלו מייל אישור כרגיל.</p>`,
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
    ? `<p>ניתן לשלוח בקשת גישה חדשה:</p><p><a class="btn" href="${esc(requestUrl)}">בקשת גישה חדשה</a></p>`
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
    'בקשת גישה חדשה',
    `<h1 style="font-size:20px;margin:0 0 12px">בקשת גישה חדשה ל-PDF Viewer</h1>
<p style="margin:0 0 12px">התקבלה בקשת גישה לאפליקציה ולהורדת תוכנת ההתקנה ל-Windows:</p>
<table role="presentation" cellpadding="0" cellspacing="0" dir="rtl" style="margin:0 0 20px;${FONT};font-size:15px">
${row('שם', esc(d.name))}
${row('אימייל', `<span dir="ltr">${esc(d.email)}</span>`)}
${d.company ? row('חברה', esc(d.company)) : ''}
${d.message ? row('הודעה', escMultiline(d.message)) : ''}
</table>
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding:0 0 0 12px">${button(d.approveUrl, 'אשר גישה', '#16a34a')}</td>
<td>${button(d.denyUrl, 'דחה', '#c62828')}</td>
</tr></table>
<p style="margin:20px 0 0;font-size:13px;color:#5b6470">לחיצה על כפתור פותחת דף אישור — הפעולה מתבצעת רק לאחר לחיצה נוספת בדף. הקישורים תקפים ל-14 ימים. לאחר האישור יקבל/ת המבקש/ת קישור הרשמה חד-פעמי.</p>`,
  );
  const text = [
    'בקשת גישה חדשה ל-PDF Viewer',
    '',
    `שם: ${d.name}`,
    `אימייל: ${d.email}`,
    d.company ? `חברה: ${d.company}` : '',
    d.message ? `הודעה:\n${d.message}` : '',
    '',
    `אשר גישה: ${d.approveUrl}`,
    '',
    `דחה: ${d.denyUrl}`,
    '',
    'הקישורים פותחים דף אישור; הפעולה מתבצעת רק לאחר לחיצה נוספת. תקפים ל-14 ימים.',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  return { subject: `בקשת גישה ל-PDF Viewer: ${d.name}`, html, text };
}

/** Sent to an address typed into a public form, so it deliberately contains no user-supplied text. */
export function requesterAckEmail(): Rendered {
  return {
    subject: 'בקשת הגישה ל-PDF Viewer התקבלה',
    html: emailShell(
      'הבקשה התקבלה',
      `<h1 style="font-size:20px;margin:0 0 12px">הבקשה התקבלה וממתינה לאישור</h1>
<p style="margin:0 0 12px">תודה על הפנייה. לאחר אישור הבקשה יישלח אליכם מייל עם קישור חד-פעמי להרשמה ל-PDF Viewer.</p>
<p style="margin:0;font-size:13px;color:#5b6470">אם לא אתם ביקשתם — אפשר להתעלם מהודעה זו.</p>`,
    ),
    text:
      'הבקשה התקבלה וממתינה לאישור.\n\nלאחר אישור הבקשה יישלח אליכם מייל עם קישור חד-פעמי להרשמה ל-PDF Viewer.\n\nאם לא אתם ביקשתם — אפשר להתעלם מהודעה זו.',
  };
}

/** Sent to the requester after the owner approves: one-time registration link (passkey or email code). */
export function inviteEmail(d: { name: string; inviteUrl: string; hours: number }): Rendered {
  const html = emailShell(
    'הגישה אושרה',
    `<h1 style="font-size:20px;margin:0 0 12px">שלום ${esc(d.name)},</h1>
<p style="margin:0 0 12px">הגישה שלך ל-PDF Viewer אושרה. נשאר צעד אחד: להשלים את ההרשמה.</p>
<p style="margin:0 0 20px">${button(d.inviteUrl, 'הרשמה ל-PDF Viewer', '#2563eb')}</p>
<p style="margin:0 0 12px">אפשר להירשם עם <strong>טביעת אצבע</strong> / <strong>זיהוי פנים (Face ID)</strong> / <strong>Windows Hello</strong>, או להמשיך עם <strong>קוד במייל</strong>.</p>
<h2 style="font-size:17px;margin:0 0 8px">מה יקרה?</h2>
<ol style="margin:0 0 16px;padding-right:20px;padding-left:0">
<li style="margin-bottom:6px">הקישור יפתח את דף ההרשמה של PDF Viewer.</li>
<li style="margin-bottom:6px">אם במכשיר יש חיישן טביעת אצבע / זיהוי פנים / Windows Hello — אפשר ליצור מפתח גישה (Passkey) שנשמר במכשיר בלבד, ולהיכנס בהמשך בלי סיסמה. אפשר גם לסרוק קוד QR עם הטלפון.</li>
<li style="margin-bottom:6px">אין חיישן כזה? בוחרים <strong>המשך עם קוד במייל</strong>. בכניסות הבאות מזינים את כתובת המייל ומקבלים קוד חד-פעמי בן 6 ספרות.</li>
</ol>
<p style="margin:0;font-size:13px;color:#5b6470">הקישור חד-פעמי, תקף ל-${esc(d.hours)} שעות ומיועד לך בלבד — אל תעבירו אותו. אם פג תוקפו, אפשר לבקש גישה מחדש.</p>`,
  );
  const text = [
    `שלום ${d.name},`,
    '',
    'הגישה שלך ל-PDF Viewer אושרה. נשאר צעד אחד: להשלים את ההרשמה.',
    '',
    `להרשמה: ${d.inviteUrl}`,
    '',
    'אפשר להירשם עם טביעת אצבע / זיהוי פנים / Windows Hello, או להמשיך עם קוד במייל.',
    '',
    `הקישור חד-פעמי, תקף ל-${d.hours} שעות ומיועד לך בלבד.`,
  ].join('\n');
  return { subject: 'הגישה שלך ל-PDF Viewer אושרה', html, text };
}

/** Sent to the owner when someone completes passkey registration; carries the revoke link. */
export function ownerRegisteredEmail(d: { name: string; email: string; revokeUrl: string; method?: 'passkey' | 'email' }): Rendered {
  const how =
    d.method === 'email'
      ? 'המשתמש/ת נרשם/ה עם קוד במייל (בלי מפתח גישה) ויכול/ה כעת להיכנס ל-PDF Viewer עם קוד חד-פעמי שנשלח למייל, ולהוריד את תוכנת ההתקנה.'
      : 'המשתמש/ת השלים/ה רישום מפתח גישה ויכול/ה כעת להיכנס ל-PDF Viewer ולהוריד את תוכנת ההתקנה.';
  const html = emailShell(
    'הרשמה הושלמה',
    `<h1 style="font-size:20px;margin:0 0 12px">${esc(d.name)} נרשם/ה בהצלחה</h1>
<p style="margin:0 0 12px">${how}</p>
<table role="presentation" cellpadding="0" cellspacing="0" dir="rtl" style="margin:0 0 20px;${FONT};font-size:15px">
${row('שם', esc(d.name))}
${row('אימייל', `<span dir="ltr">${esc(d.email)}</span>`)}
</table>
<p style="margin:0 0 12px">${button(d.revokeUrl, 'בטל גישה', '#c62828')}</p>
<p style="margin:0;font-size:13px;color:#5b6470">שמרו את המייל הזה: הכפתור פותח דף אישור, והגישה תבוטל רק לאחר לחיצה נוספת. הקישור תקף לשנה.</p>`,
  );
  const text = [
    `${d.name} נרשם/ה בהצלחה ל-PDF Viewer`,
    '',
    how,
    '',
    `שם: ${d.name}`,
    `אימייל: ${d.email}`,
    '',
    `בטל גישה: ${d.revokeUrl}`,
    '',
    'הקישור פותח דף אישור; הגישה תבוטל רק לאחר לחיצה נוספת. תקף לשנה.',
  ].join('\n');
  return { subject: `${d.name} נרשם/ה בהצלחה ל-PDF Viewer`, html, text };
}

export function denyEmail(d: { name: string }): Rendered {
  return {
    subject: 'בקשת הגישה ל-PDF Viewer',
    html: emailShell(
      'בקשת הגישה',
      `<h1 style="font-size:20px;margin:0 0 12px">שלום ${esc(d.name)},</h1>
<p style="margin:0">תודה על ההתעניינות ב-PDF Viewer. לצערנו לא נוכל לאשר את בקשת הגישה בשלב זה.</p>`,
    ),
    text: `שלום ${d.name},\n\nתודה על ההתעניינות ב-PDF Viewer. לצערנו לא נוכל לאשר את בקשת הגישה בשלב זה.`,
  };
}

/** Email login code. Contains no user-supplied text besides the code itself. */
export function loginCodeEmail(d: { code: string; minutes: number }): Rendered {
  const html = emailShell(
    'קוד הכניסה שלך',
    `<h1 style="font-size:20px;margin:0 0 12px">קוד הכניסה שלך ל-PDF Viewer</h1>
<p style="margin:0 0 16px">הזינו את הקוד בדף הכניסה:</p>
<p dir="ltr" style="margin:0 0 16px;text-align:center"><span style="display:inline-block;font-family:'Courier New',Consolas,Menlo,monospace;font-size:34px;font-weight:bold;letter-spacing:8px;background:#f4f5f7;border:1px solid #d9dde3;border-radius:8px;padding:12px 20px;color:#1f2328">${esc(d.code)}</span></p>
<p style="margin:0 0 12px">הקוד תקף ל-${esc(d.minutes)} דקות וניתן להשתמש בו פעם אחת.</p>
<p style="margin:0;font-size:13px;color:#5b6470">אם לא ביקשת — התעלם מהודעה זו. אל תעבירו את הקוד לאף אחד.</p>`,
  );
  const text = [
    `קוד הכניסה שלך ל-PDF Viewer: ${d.code}`,
    '',
    `הקוד תקף ל-${d.minutes} דקות וניתן להשתמש בו פעם אחת.`,
    '',
    'אם לא ביקשת — התעלם מהודעה זו.',
  ].join('\n');
  return { subject: `קוד הכניסה שלך ל-PDF Viewer: ${d.code}`, html, text };
}
