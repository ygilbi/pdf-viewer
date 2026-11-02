# הורדה באישור — מדריך הגדרה

תוכנת ההתקנה של PDF Viewer ל-Windows נמצאת כ-Release במאגר הפרטי ב-GitHub. כל מי שרוצה להוריד ממלא טופס בכתובת `/download`, ואתם מקבלים מייל עם שני כפתורים: **אשר הורדה** / **דחה**. רק אחרי אישור נשלח למבקש מייל עם קישור הורדה אישי ומוגבל בזמן.

## איך זה עובד

1. המבקש ממלא את הטופס ← `POST /api/request-access`.
2. נשלח אליכם מייל (ל-`OWNER_EMAIL`) עם פרטי המבקש וכפתורי אישור/דחייה. למבקש נשלח מייל קצר „הבקשה התקבלה וממתינה לאישור” (ניתן לכבות).
3. לחיצה על „אשר הורדה” פותחת **דף אישור** — הפעולה מתבצעת רק אחרי לחיצה נוספת על „אשר ושלח קישור הורדה”. (סורקי קישורים במערכות דואר פותחים קישורים אוטומטית; כך הם לא יאשרו בקשה בטעות.)
4. אחרי האישור נשלח למבקש מייל עם כפתור „הורד את PDF Viewer ל-Windows” והוראות התקנה. הקישור תקף `DOWNLOAD_LINK_DAYS` ימים (ברירת מחדל 3).
5. לחיצה על הקישור ← השרת מאמת אותו, מוצא ב-GitHub את ה-Release החדש ביותר שהתג שלו מתחיל ב-`desktop-v`, ומפנה את הדפדפן לקישור הורדה זמני של GitHub. כל הורדה נרשמת ביומן (Logs) של Vercel עם כתובת המייל.

אין מסד נתונים: הקישורים חתומים קריפטוגרפית (HMAC-SHA256) עם `SIGNING_SECRET`, וזה מה שמונע זיוף.

## שלב 1 — סיסמת אפליקציה של Gmail (לשליחת המיילים)

1. היכנסו לחשבון Google שממנו יישלחו המיילים.
2. ודאו ש**אימות דו-שלבי** (2-Step Verification) מופעל: <https://myaccount.google.com/security>. בלי זה אי אפשר ליצור סיסמת אפליקציה.
3. פתחו <https://myaccount.google.com/apppasswords>.
4. הקלידו שם (למשל `PDF Viewer Vercel`) ולחצו **Create**.
5. העתיקו את הסיסמה בת 16 התווים (אפשר בלי הרווחים). זה הערך של `SMTP_PASS`. כתובת ה-Gmail עצמה היא `SMTP_USER`.

> ב-Gmail המייל נשלח תמיד מהכתובת של `SMTP_USER`. יש מגבלה של כ-500 מיילים ביום — הרבה יותר מהנדרש כאן.

## שלב 2 — טוקן GitHub (לגישה לקובץ ההתקנה במאגר הפרטי)

1. GitHub ← תמונת הפרופיל ← **Settings** ← **Developer settings** ← **Personal access tokens** ← **Fine-grained tokens** ← **Generate new token** (או ישירות: <https://github.com/settings/personal-access-tokens/new>).
2. **Token name**: למשל `pdf-viewer-downloads`.
3. **Expiration**: בחרו תוקף (למשל שנה) ורשמו לעצמכם תזכורת לחדש. כשהטוקן פג, ההורדות ייכשלו עד שתעדכנו אותו.
4. **Repository access**: **Only select repositories** ← `ygilbi/pdf-viewer` בלבד.
5. **Permissions** ← **Repository permissions** ← **Contents** ← **Read-only**. (Metadata: Read-only נוסף אוטומטית.) אין צורך בשום הרשאה אחרת.
6. **Generate token** והעתיקו את הערך (מתחיל ב-`github_pat_`). זה `GITHUB_TOKEN`.

## שלב 3 — מפתח חתימה `SIGNING_SECRET`

מחרוזת אקראית ארוכה (מומלץ 64 תווים; מינימום 32). אחת מהאפשרויות:

```bash
openssl rand -hex 32
```

או ב-Node: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

אל תשמרו אותו במאגר. החלפת המפתח מבטלת מיידית את כל הקישורים שנשלחו (אישור והורדה) — שימושי אם קישור דלף.

## שלב 4 — משתני סביבה ב-Vercel

Vercel ← הפרויקט ← **Settings** ← **Environment Variables**. הוסיפו לסביבת **Production** (ואם רוצים גם ל-Preview):

| משתנה | חובה | ערך |
|---|---|---|
| `OWNER_EMAIL` | כן | הכתובת שלכם — לשם יגיעו בקשות האישור |
| `SMTP_USER` | כן | כתובת ה-Gmail השולחת |
| `SMTP_PASS` | כן | סיסמת האפליקציה משלב 1 |
| `SIGNING_SECRET` | כן | המחרוזת משלב 3 (לפחות 32 תווים) |
| `GITHUB_TOKEN` | כן | הטוקן משלב 2 |
| `APP_URL` | מומלץ | `https://pdf-viewer-lemon.vercel.app` (בלי `/` בסוף). אם לא מוגדר — נגזר מכתובת הבקשה |
| `DOWNLOAD_LINK_DAYS` | לא | תוקף קישור ההורדה בימים (ברירת מחדל `3`) |
| `SEND_REQUESTER_ACK` | לא | `true` (ברירת מחדל) — לשלוח למבקש „הבקשה התקבלה”; `false` לכבות |
| `SEND_DENY_EMAIL` | לא | `false` (ברירת מחדל); `true` — לשלוח למבקש הודעת דחייה מנומסת |
| `MAIL_FROM` | לא | שם השולח, ברירת מחדל `"PDF Viewer" <SMTP_USER>` |
| `SMTP_HOST` / `SMTP_PORT` | לא | ברירת מחדל `smtp.gmail.com` / `465` (לשרת דואר אחר) |
| `GITHUB_REPO` | לא | ברירת מחדל `ygilbi/pdf-viewer` |

סמנו את `SMTP_PASS`, `SIGNING_SECRET` ו-`GITHUB_TOKEN` כ-**Sensitive**.

## שלב 5 — פריסה מחדש

משתני סביבה נכנסים לתוקף רק בפריסה חדשה: **Deployments** ← הפריסה האחרונה ← **⋯** ← **Redeploy** (או push חדש ל-`main`).

## שלב 6 — בדיקה

1. פתחו `https://pdf-viewer-lemon.vercel.app/download` ושלחו בקשה עם כתובת מייל נוספת שלכם.
2. בדקו שהגיע אליכם מייל „בקשת הורדה ל-PDF Viewer” (בדקו גם בספאם בפעם הראשונה).
3. לחצו „אשר הורדה” ← בדף שנפתח לחצו „אשר ושלח קישור הורדה” ← אמור להופיע „ההורדה אושרה — נשלח מייל אל …”.
4. בתיבה של המבקש לחצו „הורד את PDF Viewer ל-Windows” ← ההורדה של `PDF-Viewer-Setup-….exe` אמורה להתחיל.
5. ב-Vercel ← **Logs** אפשר לראות שורות `[download-approval] …` (בקשות, אישורים, הורדות ושגיאות).

### תקלות נפוצות

| תסמין | סיבה אפשרית |
|---|---|
| הטופס מחזיר „השירות אינו מוגדר כרגע” | חסר משתנה סביבה או ש-`SIGNING_SECRET` קצר מ-32 תווים. שם המשתנה החסר מופיע ב-Logs. לא לשכוח Redeploy |
| „שליחת הבקשה נכשלה” | `SMTP_USER`/`SMTP_PASS` שגויים, או שסיסמת האפליקציה בוטלה |
| „ההורדה אינה זמינה כרגע” | `GITHUB_TOKEN` פג או בלי הרשאת Contents, או שאין Release `desktop-v*` עם קובץ `PDF-Viewer-Setup-*.exe` |
| „הקישור אינו תקף” | הקישור פג תוקף, הועתק חלקית, או ש-`SIGNING_SECRET` הוחלף |

## גרסאות חדשות

אין צורך לשנות דבר: פרסמו Release חדש עם תג `desktop-v…` וקובץ `PDF-Viewer-Setup-<גרסה>.exe`. ההורדה תמיד מפנה ל-Release היציב החדש ביותר (טיוטות לא נכללות; Pre-release רק אם אין גרסה יציבה עם קובץ התקנה).

## מגבלות (בגלל שאין מסד נתונים)

- קישור הורדה אפשר להשתמש בו כמה פעמים בתוך תקופת התוקף, וגם להעביר לאחר. כל שימוש נרשם ב-Logs עם המייל שאליו נשלח. לביטול כללי — החליפו את `SIGNING_SECRET`.
- לחיצה כפולה על „אשר” תשלח את מייל ההורדה פעמיים. אין רישום של בקשות שכבר טופלו.
- מגבלת הקצב (5 בקשות לכתובת IP ב-10 דקות) נשמרת בזיכרון של מופע השרת, ומופעי Vercel קצרי חיים ומקבילים — זו הגנה בסיסית בלבד. בנוסף יש שדה „מלכודת” נסתר לבוטים ומגבלת גודל של 8KB לבקשה.
- מייל „הבקשה התקבלה” נשלח לכתובת שהוקלדה בטופס, ולכן אינו כולל שום טקסט שהמבקש כתב (כדי שלא ינוצל לשליחת ספאם). אם תרצו — כבו אותו עם `SEND_REQUESTER_ACK=false`.

## פרטים טכניים

- קוד: `api/request-access.ts`, `api/approve.ts`, `api/deny.ts`, `api/download.ts`; ספריות משותפות ב-`api/_lib/` (תיקיות שמתחילות ב-`_` אינן הופכות לפונקציות ב-Vercel). בדיקות: `api/_tests/`.
- בדיקות מקומיות: `npm run typecheck:api` ו-`npx vitest run`.
- `POST /api/request-access` מקבל JSON ‏`{ name, email, company?, message?, website? }` ומחזיר `{ ok: true }`, או `{ ok: false, code, error, fields? }` (`error` = הודעה בעברית להצגה, `fields` = שגיאות לפי שדה) עם סטטוס 400 (`validation` / `bad_json`), 413 (`too_large`), 429 (`rate_limited`), 500 (`server_config`) או 502 (`mail_failed`).
