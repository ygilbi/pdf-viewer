# גישה ל-PDF Viewer — מדריך הגדרה

האפליקציה (`/`) וההורדה של תוכנת ההתקנה ל-Windows (`/api/download`) פתוחות רק למשתמשים מאושרים. הכניסה היא עם **מפתח גישה (Passkey)** — Face ID, טביעת אצבע או Windows Hello — בלי סיסמאות.

## איך זה עובד

1. **בקשת גישה** — בעמוד `/login` המשתמש ממלא שם ואימייל (`POST /api/auth/request`). נוצרת רשומה במצב `pending`.
2. **אישור במייל** — אתם (`OWNER_EMAIL`) מקבלים מייל עם **אשר גישה** / **דחה**. כל כפתור פותח **דף אישור**, והפעולה מתבצעת רק אחרי לחיצה נוספת (סורקי קישורים במערכות דואר לא יאשרו בטעות).
3. **קישור הרשמה חד-פעמי** — אחרי האישור המשתמש מקבל מייל „הגישה שלך ל-PDF Viewer אושרה” עם קישור `…/login?invite=…`. הקישור תקף `INVITE_HOURS` שעות (ברירת מחדל 72) ואפשר להשתמש בו פעם אחת בלבד.
4. **רישום מפתח גישה** — בקישור המכשיר מבקש Face ID / טביעת אצבע / Windows Hello ונוצר מפתח גישה שנשמר במכשיר (או בטלפון, דרך סריקת QR). עם סיום הרישום אתם מקבלים מייל „<שם> נרשם/ה בהצלחה” עם כפתור **בטל גישה** — שמרו אותו.
5. **כניסות הבאות** — רק עם מפתח הגישה. ההתחברות נשמרת בעוגייה מאובטחת למשך `SESSION_DAYS` ימים (ברירת מחדל 30).

המידע נשמר ב-**Upstash Redis** (משתמשים, מפתחות ציבוריים של ה-Passkeys, הזמנות חד-פעמיות). אין סיסמאות ואין מידע ביומטרי בשרת — טביעת האצבע / הפנים לא יוצאות מהמכשיר.

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

סמנו את `SMTP_PASS`, `SIGNING_SECRET` ו-`GITHUB_TOKEN` כ-**Sensitive**.

> **חשוב — דומיין קבוע:** מפתח גישה קשור לדומיין שבו נרשם. אם תעברו לדומיין אחר (דומיין מותאם אישית), המשתמשים יצטרכו להירשם מחדש. בכתובות Preview של Vercel ההרשמה לא תעבוד כש-`APP_URL` מצביע על הדומיין הראשי — זה צפוי.

## שלב 6 — פריסה מחדש

משתני סביבה נכנסים לתוקף רק בפריסה חדשה: **Deployments** ← הפריסה האחרונה ← **⋯** ← **Redeploy**.

## שלב 7 — בדיקה עם `/api/health`

פתחו `https://pdf-viewer-lemon.vercel.app/api/health`. מוצג JSON (ללא שום ערך סודי):

```json
{
  "ok": true,
  "env": { "OWNER_EMAIL": true, "SMTP_USER": true, "SMTP_PASS": true, "SIGNING_SECRET": true, "GITHUB_TOKEN": true, "KV": true },
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
3. במייל „הגישה שלך ל-PDF Viewer אושרה” לחצו **הרשמה ל-PDF Viewer** ← אשרו עם Face ID / טביעת אצבע / Windows Hello.
4. תועברו לאפליקציה. מעכשיו — **כניסה עם Face ID / טביעת אצבע** בעמוד `/login`.

מכשיר נוסף: מפתחות גישה של Apple (iCloud Keychain) ו-Google (Password Manager) מסתנכרנים אוטומטית בין המכשירים שלכם. במחשב בלי המפתח (למשל Windows) בוחרים בחלון הדפדפן „טלפון או טאבלט” וסורקים QR עם הטלפון הרשום. אם צריך לרשום מפתח חדש לגמרי — בטלו את הגישה (למטה) ובקשו גישה מחדש.

## ביטול גישה

- במייל „<שם> נרשם/ה בהצלחה” לחצו **בטל גישה** ← **בטל גישה** בדף האישור (הקישור תקף שנה).
- התוצאה מיידית: הסטטוס הופך ל-`revoked`, כל מפתחות הגישה של המשתמש נמחקים, וכל ההתחברויות הפעילות שלו נחסמות (גם בדפדפן שכבר פתוח — בכל טעינת דף ובכל בקשה ל-`/api/auth/me` / `/api/download`).
- אם המשתמש יבקש גישה שוב — תקבלו מייל אישור חדש כרגיל.
- חירום (ביטול לכולם): החליפו את `SIGNING_SECRET` ← Redeploy. כולם מנותקים וכל הקישורים שנשלחו מתבטלים.
- ניהול ידני: ב-Upstash Console ← Data Browser אפשר לראות/לערוך את המפתחות `user:<email>` (שדה `status`).

## פרטים טכניים

- **API** (JSON: `{ ok: true, … }` או `{ ok: false, code, error }` כש-`error` הודעה בעברית):
  - `POST /api/auth/request` `{ name, email, company?, message?, website? }` → `{ ok }` / `{ ok, alreadyActive: true }`. שגיאות: `validation` 400, `bad_json` 400, `too_large` 413, `rate_limited` 429, `server_config` 500, `mail_failed` 502, `store_failed` 502. `/api/request-access` הוא כינוי ישן לאותה פונקציה.
  - `GET|POST /api/approve?t=`, `/api/deny?t=`, `/api/revoke?t=` — דפי HTML לבעלים (GET = דף אישור, POST = ביצוע).
  - `POST /api/auth/register/options` `{ invite }` → `{ ok, options, user: { name, email } }`.
  - `POST /api/auth/register/verify` `{ invite, response }` → `{ ok, user }` + עוגיית התחברות.
  - `POST /api/auth/login/options` `{}` → `{ ok, options }` + עוגייה `pv_chal` (5 דקות).
  - `POST /api/auth/login/verify` `{ response }` → `{ ok, user }` + עוגיית התחברות.
  - `GET /api/auth/me` → `{ ok, user }` או 401 `unauthenticated`. `POST /api/auth/logout` → `{ ok }`.
  - `GET /api/download` — דורש התחברות; אחרת 302 ל-`/login?next=%2Fapi%2Fdownload`. קישורי ההורדה הישנים מהמייל (`?t=`) **אינם נתמכים עוד** ומפנים גם הם ל-`/login`.
  - `GET /api/health` — אבחון (למעלה).
- **קודי שגיאה בהרשמה/כניסה**: `invite_invalid` / `invite_expired` / `invite_used` (410), `not_approved` (403), `challenge_expired` (400 — קראו שוב ל-options ונסו שוב), `verification_failed` (400), `credential_exists` (409), `unknown_credential` (401), `not_active` (403), `rate_limited` (429), `store_failed` (502).
- **עוגיית התחברות** `pv_session`: חתומה ב-HMAC-SHA256 עם `SIGNING_SECRET`, `HttpOnly; Secure; SameSite=Lax; Path=/`. תקפה רק כל עוד המשתמש במצב `active` ובאותו "דור" התחברות (ביטול מקדם את הדור).
- **WebAuthn** (`@simplewebauthn/server` v14): `residentKey: required`, `userVerification: required`, attestation `none`, ללא חיוב `authenticatorAttachment` (רמזים: `client-device`, `hybrid` — כך שטלפון דרך QR אפשרי). כניסה עם discoverable credentials (`allowCredentials` ריק), בדיקת מונה החתימות ועדכונו.
- **Middleware** (`middleware.ts` בשורש, Vercel Routing Middleware; הלוגיקה ב-`api/_lib/gate.ts`): מגן על `/`, `/index.html` ונתיבי SPA בלי סיומת. בלי התחברות תקפה (חתימה + סטטוס ב-Redis) ← 302 ל-`/login?next=<נתיב>`. לא נוגע ב-`/login`, `/download`, `/api/*`, `/assets/*`, `/icons/*`, `/tools/*`, `/manifest.webmanifest`, `/sw.js`. בקשות שאינן ניווט (למשל ה-Service Worker ששומר את `index.html` במטמון) עוברות — קוד האפליקציה אינו סודי; ההגנה האמיתית היא על ה-API וההורדה. כשל ב-Redis ← הפניה ל-`/login` (fail closed).
- **PWA offline**: ה-Service Worker עשוי להגיש `index.html` מהמטמון כשאין רשת — זה מקובל (אין גישה לשרת במצב כזה ממילא).
- **Redis** (מפתחות): `user:{email}`, `cred:{credentialId}`, `usercreds:{email}` (Set), `invite:{jti}` (TTL = `INVITE_HOURS`), `challenge:{id}` (TTL 5 דקות).
- קוד: `api/auth/*`, `api/{approve,deny,revoke,download,health}.ts`, `api/_lib/*`. בדיקות: `api/_tests/` (כולל מאמת WebAuthn תוכנתי שמייצר חתימות ES256 אמיתיות). הרצה: `npm run typecheck:api` ו-`npx vitest run`.
