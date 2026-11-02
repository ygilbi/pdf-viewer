# גישה ל-PDF Viewer — מדריך הגדרה

האפליקציה (`/`) וההורדה של תוכנת ההתקנה ל-Windows (`/api/download`) פתוחות רק למשתמשים מאושרים. הכניסה היא בלי סיסמאות: עם **מפתח גישה (Passkey)** — Face ID, טביעת אצבע או Windows Hello — או, במחשבים בלי חיישן כזה, עם **קוד חד-פעמי במייל**, או (אופציונלי) **כניסה עם Google**. בכל הדרכים הגישה עצמה דורשת את אישורכם.

## איך זה עובד

1. **בקשת גישה** — בעמוד `/login` המשתמש ממלא שם ואימייל (`POST /api/auth/request`). נוצרת רשומה במצב `pending`.
2. **אישור במייל** — אתם (`OWNER_EMAIL`) מקבלים מייל עם **אשר גישה** / **דחה**. כל כפתור פותח **דף אישור**, והפעולה מתבצעת רק אחרי לחיצה נוספת (סורקי קישורים במערכות דואר לא יאשרו בטעות).
3. **קישור הרשמה חד-פעמי** — אחרי האישור המשתמש מקבל מייל „הגישה שלך ל-PDF Viewer אושרה” עם קישור `…/login?invite=…`. הקישור תקף `INVITE_HOURS` שעות (ברירת מחדל 72) ואפשר להשתמש בו פעם אחת בלבד.
4. **השלמת ההרשמה** — בקישור בוחרים אחת משתי דרכים:
   - **מפתח גישה** — המכשיר מבקש Face ID / טביעת אצבע / Windows Hello ונוצר מפתח גישה שנשמר במכשיר (או בטלפון, דרך סריקת QR).
   - **המשך עם קוד במייל** — בלי מפתח גישה (`POST /api/auth/register/email`). הקישור עצמו נשלח לכתובת המייל, ולכן הוא מוכיח שהכתובת שייכת למשתמש.

   עם סיום ההרשמה אתם מקבלים מייל „<שם> נרשם/ה בהצלחה” (מצוין אם נרשם/ה עם קוד במייל) עם כפתור **בטל גישה** — שמרו אותו.
5. **כניסות הבאות** — עם מפתח הגישה, או עם קוד במייל (למטה). ההתחברות נשמרת בעוגייה מאובטחת למשך `SESSION_DAYS` ימים (ברירת מחדל 30). משתמש שנכנס עם קוד יכול להוסיף מפתח גישה למכשיר בכל שלב (`/api/auth/passkey/add/*`).

## כניסה עם קוד במייל

לרוב המחשבים אין חיישן טביעת אצבע / מצלמת זיהוי פנים, ולכן אפשר להיכנס גם בלי מפתח גישה:

1. בעמוד `/login` מזינים את כתובת המייל ← **שלח לי קוד** (`POST /api/auth/email/start`).
2. מגיע מייל „קוד הכניסה שלך ל-PDF Viewer: 123456” — קוד בן 6 ספרות, תקף **10 דקות**, לשימוש חד-פעמי. בקשת קוד חדש מבטלת את הקודם.
3. מזינים את הקוד (`POST /api/auth/email/verify`) ← נכנסים לאפליקציה.

הגבלות ואבטחה:
- קוד נשלח רק למשתמש במצב `active` (כלומר שהשלים הרשמה). כתובת לא רשומה / שעדיין לא אושרה ← הודעה „כתובת המייל לא רשומה או שעדיין לא אושרה. בקש/י גישה.” (ולא נשלח מייל).
- עד **5 קודים לשעה** לכל כתובת, ולפחות **30 שניות** בין שליחות (נשמר ב-Redis, כך שזה תקף בין כל מופעי השרת). בנוסף הגבלה לפי כתובת IP.
- עד **5 ניסיונות** לכל קוד; אחרי החמישי הקוד נמחק וצריך לבקש חדש.
- הקוד עצמו לא נשמר — רק HMAC-SHA256 שלו (עם `SIGNING_SECRET`), וההשוואה נעשית בזמן קבוע.
- ביטול גישה חוסם מיד גם כניסה בקוד (הסטטוס כבר אינו `active`).
- האבטחה של כניסה בקוד שקולה לאבטחת תיבת המייל של המשתמש. מפתח גישה חזק יותר — מומלץ להוסיף אותו במכשירים שתומכים בכך.

המידע נשמר ב-**Upstash Redis** (משתמשים, מפתחות ציבוריים של ה-Passkeys, הזמנות חד-פעמיות). אין סיסמאות ואין מידע ביומטרי בשרת — טביעת האצבע / הפנים לא יוצאות מהמכשיר.

## כניסה עם Google

כפתור **כניסה עם Google** בעמוד `/login` (OAuth 2.0 / OpenID Connect, ללא ספריות צד-שלישי). Google רק **מאמת את כתובת המייל** — ההחלטה מי מקבל גישה נשארת שלכם:

| מצב המשתמש (לפי המייל של חשבון Google) | מה קורה |
|---|---|
| `active` (כבר רשום/ה) | נכנס/ת מיד ← חוזר/ת לעמוד שממנו הגיע/ה (`next`, ברירת מחדל `/`) |
| `approved` (אישרתם, אבל עוד לא השלים/ה הרשמה) | ההרשמה מושלמת עכשיו (Google אימת את המייל): הסטטוס הופך ל-`active`, קישורי ההרשמה שנשלחו מבוטלים, ואתם מקבלים מייל „<שם> נרשם/ה בהצלחה (Google)” עם כפתור **בטל גישה** ← `/welcome` |
| לא מוכר / `pending` / `revoked` | נשלחת אליכם **בקשת גישה רגילה** (אשר/דחה), עם הציון „כתובת המייל אומתה על ידי Google”, והמשתמש/ת רואה „הבקשה ממתינה לאישור”. אם כבר יש בקשה ממתינה מ-24 השעות האחרונות — לא נשלח מייל נוסף |
| `denied` | הודעה שהבקשה נדחתה; לא נשלח מייל |

אחרי שאישרתם בקשה כזו, המשתמש/ת יכול/ה פשוט ללחוץ שוב **כניסה עם Google** (או להשתמש בקישור ההרשמה מהמייל).

### הגדרה (פעם אחת, כ-10 דקות)

1. היכנסו ל-<https://console.cloud.google.com> עם חשבון Google שלכם.
2. בראש הדף ← בורר הפרויקטים ← **New Project** ← שם: `PDF Viewer` ← **Create**. ודאו שהפרויקט החדש נבחר.
3. תפריט ☰ ← **APIs & Services** ← **OAuth consent screen** (בממשק החדש: **Google Auth Platform** ← **Branding** / **Audience**) ← **Get started**:
   - **App name**: `PDF Viewer`
   - **User support email**: הכתובת שלכם
   - **Audience**: **External**
   - **Contact information**: הכתובת שלכם ← **Create**.
   - **Authorized domains** — השאירו ריק. `vercel.app` הוא דומיין ציבורי משותף ואי אפשר לרשום אותו כ-authorized domain; זה לא נדרש כל עוד האפליקציה מבקשת רק את ההרשאות הבסיסיות (רק עם דומיין מותאם אישית תוכלו להוסיף אותו כאן).
   - **Scopes** (Data Access): אין צורך להוסיף דבר — האפליקציה מבקשת רק `openid`, `email`, `profile`. אלו הרשאות **לא רגישות**, ולכן **אין צורך באימות (verification) של Google**.
4. **מצב Testing מול Production** (Audience ← Publishing status):
   - במצב **Testing** רק משתמשים שהוספתם ב-**Test users** (עד 100 כתובות) יכולים להיכנס עם Google; לאחרים Google יציג שגיאה „Access blocked”.
   - כדי שכל אחד יוכל לנסות ← **Publish app** ← **Confirm**. בגלל שההרשאות לא רגישות, הפרסום מיידי ואין תהליך בדיקה. (זה לא פותח גישה — כל מי שאינו מאושר עדיין יגיע לבקשת גישה שתצטרכו לאשר.)
5. **APIs & Services** ← **Credentials** (או Google Auth Platform ← **Clients**) ← **Create credentials** ← **OAuth client ID**:
   - **Application type**: **Web application**, **Name**: `PDF Viewer Vercel`
   - **Authorized JavaScript origins**: `https://pdf-viewer-lemon.vercel.app`
   - **Authorized redirect URIs**: `https://pdf-viewer-lemon.vercel.app/api/auth/google/callback` (בדיוק כך — בלי `/` בסוף)
   - **Create**.
6. בחלון שנפתח העתיקו את **Client ID** (`….apps.googleusercontent.com`) ואת **Client secret** (`GOCSPX-…`). (אפשר לחזור אליהם בכל שלב בעמוד ה-Client.)
7. Vercel ← הפרויקט ← **Settings** ← **Environment Variables** (Production):
   - `GOOGLE_CLIENT_ID` = ה-Client ID
   - `GOOGLE_CLIENT_SECRET` = ה-Client secret (סמנו **Sensitive**)
   - מומלץ גם `APP_URL` = `https://pdf-viewer-lemon.vercel.app` — כתובת ה-callback נבנית ממנו, והיא חייבת להיות זהה לזו שרשמתם ב-Google.
8. **Deployments** ← הפריסה האחרונה ← **⋯** ← **Redeploy**.
9. פתחו `https://pdf-viewer-lemon.vercel.app/api/health` ← צריך להופיע `"google": true` בתוך `env`. בעמוד `/login` יופיע הכפתור **כניסה עם Google** (`GET /api/auth/providers` מחזיר `google: true`).

בלי שני המשתנים האלה הכפתור פשוט לא מוצג והכל עובד כמו קודם.

תקלות נפוצות:
- **`Error 400: redirect_uri_mismatch`** בדף של Google — ה-Redirect URI בשלב 5 שונה מהכתובת שהאתר שולח (`<APP_URL>/api/auth/google/callback`). בדקו `https`, את הדומיין, ושאין `/` בסוף. כניסה מכתובת Preview של Vercel לא תעבוד אם `APP_URL` לא מוגדר — זה צפוי.
- **`Access blocked: … has not completed the Google verification process`** — האפליקציה במצב Testing והמשתמש לא ברשימת Test users. הוסיפו אותו, או פרסמו (שלב 4).
- חזרה ל-`/login?google=error&reason=…`:
  `google_disabled` (המשתנים חסרים), `access_denied` (המשתמש ביטל במסך של Google), `state_expired` (עברו יותר מ-10 דקות — נסו שוב), `state_invalid` (הכניסה הושלמה בדפדפן אחר / עוגיות חסומות — נסו שוב), `exchange_failed` (בדרך כלל `GOOGLE_CLIENT_SECRET` שגוי או Redirect URI לא תואם — ראו Logs), `token_invalid` (אימות ה-ID token נכשל — בדרך כלל `GOOGLE_CLIENT_ID` שגוי), `email_unverified` / `no_email` (לחשבון Google אין מייל מאומת), `store_failed` / `mail_failed` / `server_config` (ראו `/api/health`), `google_error`, `rate_limited`.

אבטחה: ה-`state` חתום (HMAC עם `SIGNING_SECRET`, תוקף 10 דקות) ומכיל `nonce` אקראי שנשמר גם בעוגייה `pv_gstate` (`HttpOnly; SameSite=Lax; Path=/api/auth/google`, 10 דקות) — כך הכניסה קשורה לדפדפן שהתחיל אותה. ה-ID token נבדק בשרת: חתימת RS256 מול המפתחות הציבוריים של Google (JWKS, נשמרים במטמון לפי `Cache-Control`), `iss` = `accounts.google.com`, `aud` = ה-Client ID, תוקף (`exp`), ה-`nonce`, ו-`email_verified: true`. `next` מתקבל רק כנתיב יחסי באותו אתר. ה-Client secret לא יוצא מהשרת.

## שלב 1 — מסד נתונים: Upstash Redis (דרך Vercel)

1. Vercel ← הפרויקט ← לשונית **Storage** ← **Create Database** / **Browse Marketplace**.
2. בחרו **Upstash** ← **Upstash for Redis** ← **Create** (התוכנית החינמית מספיקה). בחרו אזור קרוב (למשל Frankfurt).
3. **Connect to Project** ← בחרו את הפרויקט ואת הסביבות (לפחות Production).
4. משתני הסביבה `KV_REST_API_URL` ו-`KV_REST_API_TOKEN` נוספים לפרויקט אוטומטית (גם `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` נתמכים, אם יצרתם את ה-DB ישירות באתר של Upstash).

## שלב 2 — סיסמת אפליקציה של Gmail (לשליחת המיילים)

1. היכנסו לחשבון Google שממנו יישלחו המיילים.
2. ודאו ש**אימות דו-שלבי** (2-Step Verification) מופעל: <https://myaccount.google.com/security>. בלי זה אי אפשר ליצור סיסמת אפליקציה.
3. פתחו <https://myaccount.google.com/apppasswords>, הקלידו שם (למשל `PDF Viewer Vercel`) ולחצו **Create**.
4. העתיקו את הסיסמה בת 16 התווים (בלי הרווחים). זה `SMTP_PASS`. כתובת ה-Gmail עצמה היא `SMTP_USER`.

> הסיסמה הרגילה של Gmail **לא** תעבוד — רק סיסמת אפליקציה. זו הסיבה הנפוצה ביותר להודעה „שליחת הבקשה נכשלה”.

## שלב 3 — טוקן GitHub (לקובץ ההתקנה במאגר הפרטי)

1. <https://github.com/settings/personal-access-tokens/new> (Fine-grained token).
2. **Repository access**: **Only select repositories** ← `ygilbi/pdf-viewer`.
3. **Permissions** ← **Repository permissions** ← **Contents: Read-only**.
4. בחרו תוקף ורשמו תזכורת לחדש. העתיקו את הערך (`github_pat_…`) — זה `GITHUB_TOKEN`.

## שלב 4 — מפתח חתימה `SIGNING_SECRET`

מחרוזת אקראית של לפחות 32 תווים (מומלץ 64):

```bash
openssl rand -hex 32
```

החלפת המפתח מנתקת מיד את כל המשתמשים (הם יתחברו מחדש עם מפתח הגישה — המפתחות עצמם נשמרים) ומבטלת את כל הקישורים שנשלחו במייל.

## שלב 5 — משתני סביבה ב-Vercel

Vercel ← הפרויקט ← **Settings** ← **Environment Variables** (סביבת **Production**):

| משתנה | חובה | ערך |
|---|---|---|
| `OWNER_EMAIL` | כן | הכתובת שלכם — לשם יגיעו בקשות הגישה |
| `SMTP_USER` | כן | כתובת ה-Gmail השולחת |
| `SMTP_PASS` | כן | סיסמת האפליקציה משלב 2 |
| `SIGNING_SECRET` | כן | המחרוזת משלב 4 (לפחות 32 תווים) |
| `GITHUB_TOKEN` | כן | הטוקן משלב 3 |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | כן | נוספים אוטומטית בשלב 1 |
| `APP_URL` | מומלץ | `https://pdf-viewer-lemon.vercel.app` (בלי `/` בסוף). קובע את הקישורים במיילים ואת ה-RP ID של מפתחות הגישה |
| `RP_ID` | לא | דומיין מפתחות הגישה; ברירת מחדל — הדומיין של `APP_URL`, אחרת הדומיין של הבקשה |
| `INVITE_HOURS` | לא | תוקף קישור ההרשמה בשעות (ברירת מחדל `72`) |
| `SESSION_DAYS` | לא | משך ההתחברות בימים (ברירת מחדל `30`) |
| `SEND_REQUESTER_ACK` | לא | `true` (ברירת מחדל) — מייל „הבקשה התקבלה” למבקש |
| `SEND_DENY_EMAIL` | לא | `true` — מייל דחייה מנומס (ברירת מחדל `false`) |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | לא | ברירות מחדל ל-Gmail (`smtp.gmail.com`, `465`) |
| `GITHUB_REPO` | לא | ברירת מחדל `ygilbi/pdf-viewer` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | לא | מפעילים **כניסה עם Google** (ראו „כניסה עם Google” למעלה). בלעדיהם הכפתור לא מוצג |

סמנו את `SMTP_PASS`, `SIGNING_SECRET`, `GITHUB_TOKEN` ו-`GOOGLE_CLIENT_SECRET` כ-**Sensitive**.

> **חשוב — דומיין קבוע:** מפתח גישה קשור לדומיין שבו נרשם. אם תעברו לדומיין אחר (דומיין מותאם אישית), המשתמשים יצטרכו להירשם מחדש. בכתובות Preview של Vercel ההרשמה לא תעבוד כש-`APP_URL` מצביע על הדומיין הראשי — זה צפוי.

## שלב 6 — פריסה מחדש

משתני סביבה נכנסים לתוקף רק בפריסה חדשה: **Deployments** ← הפריסה האחרונה ← **⋯** ← **Redeploy**.

## שלב 7 — בדיקה עם `/api/health`

פתחו `https://pdf-viewer-lemon.vercel.app/api/health`. מוצג JSON (ללא שום ערך סודי):

```json
{
  "ok": true,
  "env": { "OWNER_EMAIL": true, "SMTP_USER": true, "SMTP_PASS": true, "SIGNING_SECRET": true, "GITHUB_TOKEN": true, "KV": true, "google": true },
  "smtp": "ok",
  "redis": "ok",
  "github": "ok",
  "installer": "desktop-v0.1.0/PDF-Viewer-Setup-0.1.0.exe",
  "rpId": "pdf-viewer-lemon.vercel.app",
  "rpIdMatchesHost": true
}
```

| מה רואים | מה לעשות |
|---|---|
| `env.X: false` | המשתנה X חסר (או `SIGNING_SECRET` קצר מ-32 תווים). הוסיפו ← Redeploy |
| `env.google: false` | כניסה עם Google כבויה (אופציונלי — לא משפיע על `ok`). להפעלה: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` ← Redeploy |
| `smtp: "error: auth failed 535"` | Gmail דחה את ההתחברות: `SMTP_PASS` אינו סיסמת אפליקציה, הועתק עם טעות, או בוטל; או ש-`SMTP_USER` אינו אותו חשבון |
| `smtp: "error: timeout"` / `"connection failed …"` | בעיית רשת/פורט — בדקו `SMTP_HOST`/`SMTP_PORT` |
| `smtp: "skipped"` | `SMTP_USER` או `SMTP_PASS` חסרים |
| `redis: "missing"` / `"error"` | ה-DB לא מחובר לפרויקט (שלב 1), או שהטוקן שגוי |
| `github: "error 401"` / `"error 404"` | הטוקן פג / ללא הרשאת Contents / לא על המאגר הנכון |
| `installer: null` | אין Release `desktop-v*` עם קובץ `PDF-Viewer-Setup-*.exe` |
| `rpIdMatchesHost: false` | פתחתם את הבדיקה מדומיין אחר מ-`APP_URL`/`RP_ID` — מפתחות גישה לא יעבדו בדומיין הזה |

כשהטופס מציג „השירות אינו מוגדר כרגע” (500) או „שליחת הבקשה נכשלה” (502), ההודעה עצמה מפנה ל-`/api/health`. פרטים נוספים ב-Vercel ← **Logs** (שורות `[access] …`).

## המשתמש הראשון (אתם)

1. פתחו `/login` ← **משתמש חדש? בקש גישה** ← שם + האימייל שלכם.
2. במייל „בקשת גישה ל-PDF Viewer” לחצו **אשר גישה** ← **אשר ושלח קישור הרשמה**.
3. במייל „הגישה שלך ל-PDF Viewer אושרה” לחצו **הרשמה ל-PDF Viewer** ← אשרו עם Face ID / טביעת אצבע / Windows Hello, או בחרו **המשך עם קוד במייל**.
4. תועברו לאפליקציה. מעכשיו — **כניסה עם Face ID / טביעת אצבע**, או **כניסה עם קוד במייל**, בעמוד `/login`.

מכשיר נוסף: מפתחות גישה של Apple (iCloud Keychain) ו-Google (Password Manager) מסתנכרנים אוטומטית בין המכשירים שלכם. במחשב בלי המפתח (למשל Windows) בוחרים בחלון הדפדפן „טלפון או טאבלט” וסורקים QR עם הטלפון הרשום. אפשר גם להיכנס במכשיר החדש עם קוד במייל ולהוסיף בו מפתח גישה נוסף.

## ביטול גישה

- במייל „<שם> נרשם/ה בהצלחה” לחצו **בטל גישה** ← **בטל גישה** בדף האישור (הקישור תקף שנה).
- התוצאה מיידית: הסטטוס הופך ל-`revoked`, כל מפתחות הגישה של המשתמש נמחקים, כניסה בקוד במייל נחסמת, וכל ההתחברויות הפעילות שלו נחסמות (גם בדפדפן שכבר פתוח — בכל טעינת דף ובכל בקשה ל-`/api/auth/me` / `/api/download`).
- אם המשתמש יבקש גישה שוב — תקבלו מייל אישור חדש כרגיל.
- חירום (ביטול לכולם): החליפו את `SIGNING_SECRET` ← Redeploy. כולם מנותקים וכל הקישורים שנשלחו מתבטלים.
- ניהול ידני: ב-Upstash Console ← Data Browser אפשר לראות/לערוך את המפתחות `user:<email>` (שדה `status`).

## פרטים טכניים

- **API** (JSON: `{ ok: true, … }` או `{ ok: false, code, error }` כש-`error` הודעה בעברית):
  - `POST /api/auth/request` `{ name, email, company?, message?, website? }` → `{ ok }` / `{ ok, alreadyActive: true }`. שגיאות: `validation` 400, `bad_json` 400, `too_large` 413, `rate_limited` 429, `server_config` 500, `mail_failed` 502, `store_failed` 502. `/api/request-access` הוא כינוי ישן לאותה פונקציה.
  - `GET|POST /api/approve?t=`, `/api/deny?t=`, `/api/revoke?t=` — דפי HTML לבעלים (GET = דף אישור, POST = ביצוע).
  - `POST /api/auth/register/options` `{ invite }` → `{ ok, options, user: { name, email } }`.
  - `POST /api/auth/register/verify` `{ invite, response }` → `{ ok, user }` + עוגיית התחברות.
  - `POST /api/auth/register/email` `{ invite }` → `{ ok, user }` + עוגיית התחברות — הרשמה בלי מפתח גישה (אותה בדיקת הזמנה כמו ב-`register/options`; ההזמנה נצרכת).
  - `POST /api/auth/email/start` `{ email }` → `{ ok, sent: true }`. שגיאות: `not_registered` 404, `too_soon` 429 (עם `retryAfter` בשניות), `rate_limited` 429 (עם `retryAfter`), `bad_request` 400, `mail_failed` 502.
  - `POST /api/auth/email/verify` `{ email, code }` → `{ ok, user }` + עוגיית התחברות. שגיאות: `code_invalid` 400 (עם `attemptsLeft`), `code_expired` 410 (פג תוקף / לא נשלח / כבר נוצל), `too_many_attempts` 429, `not_active` 403.
  - `POST /api/auth/passkey/add/options` `{}` → `{ ok, options, user }`; `POST /api/auth/passkey/add/verify` `{ response }` → `{ ok, user, hasPasskey: true }` — הוספת מפתח גישה למשתמש מחובר (401 `unauthenticated` בלי התחברות).
  - `POST /api/auth/login/options` `{}` → `{ ok, options }` + עוגייה `pv_chal` (5 דקות).
  - `POST /api/auth/login/verify` `{ response }` → `{ ok, user }` + עוגיית התחברות.
  - `GET /api/auth/me` → `{ ok, user, hasPasskey }` או 401 `unauthenticated`. `POST /api/auth/logout` → `{ ok }`.
  - `GET /api/auth/providers` → `{ ok, google: boolean, passkey: true, emailCode: true }` — אילו דרכי כניסה להציג.
  - `GET /api/auth/google/start?next=/path` → 302 ל-Google (+ עוגייה `pv_gstate`). `GET /api/auth/google/callback?code&state` → 302 ל-`next` (משתמש פעיל, + עוגיית התחברות), ל-`/welcome` (משתמש מאושר שנרשם עכשיו, + עוגיית התחברות), ל-`/login?google=pending&email=<email>` (נשלחה/ממתינה בקשת גישה), ל-`/login?google=denied`, או ל-`/login?google=error&reason=<code>`.
  - `GET /api/auth/invite-status?invite=<token>` → `{ ok, email, name, status, expired, used }` — מצב ההזמנה (חתימה תקפה נדרשת; פג תוקף / נוצל מדווחים ולא נחסמים). `status`: `pending` / `approved` / `active` / `denied` / `revoked` / `unknown`. שגיאה: `invite_invalid` 410.
  - `GET /api/download` — דורש התחברות; אחרת 302 ל-`/login?next=%2Fapi%2Fdownload`. קישורי ההורדה הישנים מהמייל (`?t=`) **אינם נתמכים עוד** ומפנים גם הם ל-`/login`.
  - `GET /api/health` — אבחון (למעלה).
- **קודי שגיאה בהרשמה/כניסה**: `invite_invalid` / `invite_expired` / `invite_used` (410), `not_approved` (403), `challenge_expired` (400 — קראו שוב ל-options ונסו שוב), `verification_failed` (400), `credential_exists` (409), `unknown_credential` (401), `not_active` (403), `rate_limited` (429), `store_failed` (502); כניסה בקוד: `not_registered` (404), `too_soon` (429), `code_invalid` (400), `code_expired` (410), `too_many_attempts` (429), `mail_failed` (502).
- **עוגיית התחברות** `pv_session`: חתומה ב-HMAC-SHA256 עם `SIGNING_SECRET`, `HttpOnly; Secure; SameSite=Lax; Path=/`. תקפה רק כל עוד המשתמש במצב `active` ובאותו "דור" התחברות (ביטול מקדם את הדור).
- **WebAuthn** (`@simplewebauthn/server` v14): `residentKey: required`, `userVerification: required`, attestation `none`, ללא חיוב `authenticatorAttachment` (רמזים: `client-device`, `hybrid` — כך שטלפון דרך QR אפשרי). כניסה עם discoverable credentials (`allowCredentials` ריק), בדיקת מונה החתימות ועדכונו.
- **Middleware** (`middleware.ts` בשורש, Vercel Routing Middleware; הלוגיקה ב-`api/_lib/gate.ts`): מגן על `/`, `/index.html`, דף הפתיחה `/welcome` / `/welcome.html` ונתיבי SPA בלי סיומת. בלי התחברות תקפה (חתימה + סטטוס ב-Redis) ← 302 ל-`/login?next=<נתיב>`. לא נוגע ב-`/login`, `/download`, `/api/*`, `/assets/*`, `/icons/*`, `/tools/*`, `/manifest.webmanifest`, `/sw.js`. בקשות שאינן ניווט (למשל ה-Service Worker ששומר את `index.html` במטמון) עוברות — קוד האפליקציה אינו סודי; ההגנה האמיתית היא על ה-API וההורדה. כשל ב-Redis ← הפניה ל-`/login` (fail closed).
- **PWA offline**: ה-Service Worker עשוי להגיש `index.html` מהמטמון כשאין רשת — זה מקובל (אין גישה לשרת במצב כזה ממילא).
- **Redis** (מפתחות): `user:{email}`, `cred:{credentialId}`, `usercreds:{email}` (Set), `invite:{jti}` (TTL = `INVITE_HOURS`), `challenge:{id}` (TTL 5 דקות), `otp:{email}` (`{ hash, exp, attempts }`, TTL 10 דקות), `otpatt:{email}` (מונה ניסיונות), `otpsend:{email}` (זמני שליחה, TTL שעה), `userinvites:{email}` (ההזמנות הפתוחות של משתמש — מבוטלות כשנרשם עם Google). ברשומת `user:{email}` נשמרים גם `requestedAt` (מתי נשלחה אליכם בקשה אחרונה) ו-`googleSub` (מזהה חשבון Google, לעיון בלבד).
- קוד: פונקציה אחת `api/router.ts` (מגבלת 12 פונקציות בתוכנית Hobby) שמפנה לנתיבים ב-`api/_routes/**` דרך המפה `ROUTES`; ספריות ב-`api/_lib/*`. בדיקות: `api/_tests/` (כולל מאמת WebAuthn תוכנתי שמייצר חתימות ES256 אמיתיות). הרצה: `npm run typecheck:api` ו-`npx vitest run`.
