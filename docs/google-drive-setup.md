# PDF Viewer ב-Google Drive — מדריך הגדרה (Google Workspace Marketplace)

אחרי ההגדרה: ב-Google Drive לוחצים לחיצה ימנית על קובץ PDF ← **פתיחה באמצעות** (Open with) ← **PDF Viewer**, והקובץ נפתח באפליקציה (https://pdf-viewer-lemon.vercel.app) עם כל כלי המדידה והתמחור. בנוסף, באפליקציה עצמה מופיע כפתור **„פתח מ-Google Drive”** (מסך הפתיחה ותפריט ☰) לבחירת קבצים מ-Drive.

## מה אפשר ומה אי אפשר — בכנות

| | |
|---|---|
| ✅ „פתיחה באמצעות ← PDF Viewer” לכל קובץ PDF ב-Drive | אחרי התקנת האפליקציה מה-Marketplace |
| ✅ PDF Viewer בראש רשימת „פתיחה באמצעות” של קובצי PDF | Drive מציג קודם את האפליקציות שהגדירו את PDF כ-**Default MIME type** (כך מוגדר כאן) |
| ✅ התקנה לכל הארגון | מנהל Google Workspace יכול להתקין לכל הדומיין (Admin console ← Apps ← Google Workspace Marketplace apps) |
| ❌ להחליף את **התצוגה המקדימה** של Drive בלחיצה כפולה | לחיצה כפולה על PDF ב-Drive פותחת תמיד את התצוגה המקדימה של Google עצמה. **אף אפליקציה חיצונית לא יכולה לשנות את זה.** מתוך התצוגה המקדימה אפשר לבחור למעלה „פתיחה באמצעות ← PDF Viewer” |
| ❌ „ברירת מחדל קבועה” במובן של Windows | אין ב-Drive הגדרת „פתח תמיד עם…” למשתמש; „Default” של Drive רק מקדם את האפליקציה לראש התפריט |

הקבצים **לא עוברים דרך השרת שלנו**: הדפדפן מוריד אותם ישירות מ-Google (גם בגלל מגבלת 4.5MB לתגובה של פונקציות Vercel). ההרשאה היא `drive.file` בלבד — גישה רק לקבצים שהמשתמש פתח באפליקציה או בחר ב-Picker (הרשאה „לא רגישה”: לא דורשת אימות אבטחה של Google).

## איך זה עובד באפליקציה

1. Drive פותח את `https://pdf-viewer-lemon.vercel.app/drive/open?state=…` כאשר `state` = JSON כמו `{"ids":["FILE_ID"],"action":"open","userId":"…","resourceKeys":{…}}`.
2. מי שלא מחובר/ת מועבר/ת ל-`/login?next=/drive/open?state=…` וחוזר/ת לשם אחרי הכניסה (הגישה עדיין דורשת את אישורכם, כרגיל).
3. האפליקציה מבקשת מ-Google אסימון `drive.file` (חלון קטן של Google; בפעם הראשונה — מסך הסכמה, אח״כ נסגר מיד). אם הדפדפן חוסם את החלון, מופיע כפתור **„המשך ל-Google Drive”**.
4. הקובץ יורד בדפדפן עם התקדמות („טוען מ-Google Drive… 42%”) ונפתח כמו קובץ מקומי (כמה קבצים: הראשון נפתח והשאר מתווספים). המדידות נשמרות מקומית בדפדפן ומשוחזרות בפתיחה הבאה של אותו קובץ.
5. הכתובת מתחלפת ל-`/` — רענון לא מוריד שוב.
6. `action: "create"` (חדש ← PDF Viewer) — פשוט פותח את האפליקציה.

באפליקציית Windows (Electron) תכונות Drive מוסתרות — היא לא יעד של Drive.

---

## הגדרה ב-Google Cloud Console (פעם אחת, כ-30 דקות + זמן בדיקה של Google)

עובדים ב**אותו פרויקט** Google Cloud שבו הוגדרה „כניסה עם Google” (ראו [access-setup.md](access-setup.md)), כדי להשתמש באותו OAuth Client ID.

### שלב 1 — הפעלת APIs

APIs & Services ← **Library** ← הפעילו (Enable):

- **Google Drive API**
- **Google Picker API**
- **Google Workspace Marketplace SDK**

### שלב 2 — מסך ההסכמה (OAuth consent screen / Google Auth Platform)

- **Data Access** (או Scopes) ← **Add or remove scopes** ← הוסיפו `https://www.googleapis.com/auth/drive.file` (מופיע כ-„See, edit, create, and delete only the specific Google Drive files you use with this app”). קיימים כבר: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
- **Branding**: שם `PDF Viewer`, לוגו (`public/icons/drive-128.png`), Application home page `https://pdf-viewer-lemon.vercel.app`, Privacy policy `https://pdf-viewer-lemon.vercel.app/privacy.html`, Terms of service `https://pdf-viewer-lemon.vercel.app/terms.html`, Authorized domain `pdf-viewer-lemon.vercel.app` (או `vercel.app`).
- **Audience**: User type **External**. כל עוד הסטטוס **Testing** — רק משתמשים שהוספתם ל-**Test users** יכולים לאשר; ל-Marketplace ציבורי צריך **In production** (בגלל ש-`drive.file` לא רגיש, המעבר ל-Production לא דורש אימות אבטחה; ייתכן שיתבקש אימות מותג — Brand verification — של הדומיין).

### שלב 3 — OAuth Client (קיים)

APIs & Services ← **Credentials** ← ה-OAuth client מסוג Web application של הכניסה עם Google:

- **Authorized JavaScript origins**: `https://pdf-viewer-lemon.vercel.app` (נדרש לחלון ה-token של Google Identity Services; כנראה כבר קיים).
- Authorized redirect URIs — ללא שינוי (`https://pdf-viewer-lemon.vercel.app/api/auth/google/callback`).

### שלב 4 — מפתח API ל-Picker

Credentials ← **Create credentials ← API key**, ואז **Edit API key**:

- **Application restrictions**: **Websites** (HTTP referrers) ← `https://pdf-viewer-lemon.vercel.app/*`
- **API restrictions**: **Restrict key** ← **Google Picker API** בלבד.

המפתח ציבורי מטבעו (הוא נשלח לכל דפדפן), ולכן ההגבלות האלה הן ההגנה שלו. הוא לא מוצג ב-`/api/health` (רק `true`/`false`).

**Project number**: בעמוד הבית של הפרויקט (Cloud overview ← Project info ← **Project number**, ספרות בלבד — לא ה-Project ID).

### שלב 5 — משתני סביבה ב-Vercel

| משתנה | ערך |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | קיימים (כניסה עם Google). ה-Client ID נשלח לדפדפן דרך `GET /api/auth/providers` (`googleClientId`) — הוא ציבורי; ה-secret לא נחשף |
| `GOOGLE_API_KEY` | מפתח ה-API משלב 4 (ל-Picker) |
| `GOOGLE_PROJECT_NUMBER` | מספר הפרויקט (ספרות) — משמש כ-`appId` של ה-Picker, וכך Google מעניק לאפליקציה גישת `drive.file` לקבצים שנבחרו |

← **Redeploy**. בדיקה: `https://pdf-viewer-lemon.vercel.app/api/health` ← `env.google`, `env.GOOGLE_API_KEY`, `env.GOOGLE_PROJECT_NUMBER` = `true`. בלי `GOOGLE_API_KEY`/`GOOGLE_PROJECT_NUMBER` רק כפתור „פתח מ-Google Drive” מוסתר; „פתיחה באמצעות” מתוך Drive עובדת עם `GOOGLE_CLIENT_ID` בלבד.

### שלב 6 — Drive API ← Drive UI integration

APIs & Services ← **Google Drive API** ← **Manage** ← לשונית **Drive UI integration**:

| שדה | ערך |
|---|---|
| Application name | `PDF Viewer` |
| Short description | `צפייה ומדידה בתוכניות PDF` / `View and measure PDF drawings` |
| Long description | `מציג תוכניות PDF לאדריכלות ואלומיניום: כיול קנה מידה, מדידת שטחים, אורכים וספירות, תמחור וייצוא ל-PDF/Excel. הקובץ נפתח בדפדפן בלבד.` |
| Application icons | העלו מ-`public/icons/`: `drive-32.png`, `drive-48.png`, `drive-96.png`, `drive-128.png`, `drive-256.png` (וגם `drive-16.png` אם נדרש) |
| **Open URL** | `https://pdf-viewer-lemon.vercel.app/drive/open` |
| **Default MIME types** | `application/pdf` |
| **Default file extensions** | `pdf` |
| Secondary MIME types / extensions | ריק |
| **Creating files** (Allow users to create new documents) | **כבוי** |
| **Importing** (Allow importing) | **כבוי** |
| Shared drives support | **מסומן** (אם השדה קיים) |

שמרו (Save).

### שלב 7 — Google Workspace Marketplace SDK ← App Configuration

APIs & Services ← **Google Workspace Marketplace SDK** ← **Manage** ← **App Configuration**:

- **App visibility**: **Public** — חובה כדי שמשתמשי `@gmail.com` (חשבונות פרטיים) יוכלו להתקין. **Private** מתאים רק למשתמשים בדומיין Google Workspace אחד (שלכם), ואז אין צורך בבדיקת Google. *(אי אפשר לשנות את זה אחרי השמירה הראשונה — בחרו בזהירות.)*
- **Installation settings**: Individual + Admin install.
- **App integrations**: סמנו **Drive extension** (משתמש בהגדרות משלב 6).
- **OAuth scopes**: `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`, `https://www.googleapis.com/auth/drive.file` (חייבים להתאים ל-consent screen).
- **Developer information**: שם, אתר `https://pdf-viewer-lemon.vercel.app`, מייל.

### שלב 8 — Store Listing

| שדה | ערך |
|---|---|
| App name | `PDF Viewer` |
| Short description (עברית / English) | `צפייה, מדידה ותמחור של תוכניות PDF ישירות מ-Google Drive.` / `View, measure and price PDF drawings straight from Google Drive.` |
| Detailed description | עברית: `PDF Viewer פותח תוכניות PDF כבדות (חזיתות, חתכים, תוכניות) בדפדפן ומאפשר לכייל קנה מידה, למדוד שטחי חזית עם ניכוי פתחים, אורכים וספירת פריטים, לתמחר כתב כמויות ולייצא ל-PDF, Excel ו-CSV. לחצו לחיצה ימנית על PDF ב-Drive ← פתיחה באמצעות ← PDF Viewer. הקבצים מעובדים בדפדפן בלבד ואינם נשמרים בשרת.` English: `PDF Viewer opens heavy PDF drawings (elevations, sections, plans) in your browser: calibrate the scale, measure façade areas with openings deducted, lengths and item counts, price a bill of quantities and export to PDF, Excel and CSV. Right-click a PDF in Drive → Open with → PDF Viewer. Files are processed in your browser only and are never stored on our server.` |
| Category | **Productivity** (או Business tools) |
| Languages | Hebrew, English |
| Icons | 128×128: `public/icons/drive-128.png`; 32×32: `public/icons/drive-32.png` |
| Application card banner (220×140) | `docs/assets/google-drive/banner-220x140.png` |
| Screenshots (1280×800) | `docs/assets/google-drive/listing-1-measure.png`, `listing-2-measurements.png`, `listing-3-pricing.png`, `listing-4-export.png`, `listing-5-open-from-drive.png` |
| Terms of service URL | `https://pdf-viewer-lemon.vercel.app/terms.html` |
| Privacy policy URL | `https://pdf-viewer-lemon.vercel.app/privacy.html` |
| Support URL | `https://pdf-viewer-lemon.vercel.app/login` (או מייל תמיכה) |

### שלב 9 — פרסום ובדיקה

- **Publish** ← האפליקציה נשלחת לבדיקה של Google (בדרך כלל ימים עד כמה שבועות; Google עשויה לבקש תיקונים, למשל סרטון הדגמה או הבהרות במדיניות הפרטיות).
- **עד האישור** — בדיקה עצמית: ב-consent screen במצב Testing הוסיפו את עצמכם כ-Test user; בעמוד ה-Store Listing של ה-SDK יש תצוגה מקדימה (**App URL / Preview**) עם כפתור **Install** — התקינו מהחשבון שלכם. (באפליקציה **Private** בדומיין Workspace — ההתקנה זמינה מיד לדומיין.)
- אחרי ההתקנה: ב-Drive ← לחיצה ימנית על PDF ← **פתיחה באמצעות** ← **PDF Viewer**. בפעם הראשונה Google מבקש אישור גישה לקובץ.
- מנהלי Google Workspace יכולים להתקין לכל הארגון מה-Marketplace (Admin install).

## פתרון בעיות

| מה רואים | מה לעשות |
|---|---|
| PDF Viewer לא מופיע ב-„פתיחה באמצעות” | האפליקציה לא הותקנה בחשבון הזה (Marketplace ← Install), או שה-Drive UI integration לא נשמר / Default MIME type חסר. ייתכן עיכוב של כמה דקות אחרי ההתקנה |
| „החיבור ל-Google Drive אינו מוגדר בשרת” | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` חסרים ← `/api/health` |
| חלון Google: `redirect_uri_mismatch` / `origin_mismatch` | הוסיפו `https://pdf-viewer-lemon.vercel.app` ל-Authorized JavaScript origins (שלב 3) |
| חלון Google: „This app is blocked” / `access_denied` לחשבון אחר | ה-consent screen במצב Testing — הוסיפו את המשתמש ל-Test users, או העבירו ל-In production |
| „הקובץ לא נמצא… או שאין לאפליקציה הרשאה אליו” | `drive.file` מכסה רק קבצים שנפתחו באפליקציה / נבחרו ב-Picker. פתחו שוב מ-Drive דרך „פתיחה באמצעות”, או ב-„פתח מ-Google Drive”. ודאו ש-Drive API מופעל (שלב 1) |
| „אין הרשאה לקובץ הזה” | החשבון שאישר בחלון של Google אינו החשבון שיש לו גישה לקובץ |
| כפתור „פתח מ-Google Drive” לא מופיע | `GOOGLE_API_KEY` / `GOOGLE_PROJECT_NUMBER` חסרים או שגויים (ספרות בלבד), או שזו אפליקציית Windows |
| ה-Picker מציג „The API developer key is invalid” | הגבלת ה-referrer לא תואמת (`https://pdf-viewer-lemon.vercel.app/*`) או ש-Picker API לא מופעל / לא ברשימת ה-API restrictions |
| „הדפדפן חסם את חלון ההרשאה” | לחצו „המשך ל-Google Drive” (לחיצה מאפשרת את החלון) או אפשרו חלונות קופצים לאתר |

## פרטים טכניים

- קוד: `src/drive/` — `driveState.ts` (פענוח `state`), `driveFetch.ts` (הורדה עם התקדמות, `X-Goog-Drive-Resource-Keys`, דחיית קבצים שאינם PDF לפני הורדה, שגיאות בעברית), `google.ts` (טעינה עצלה של `https://accounts.google.com/gsi/client` ו-`https://apis.google.com/js/api.js`, token client, Picker), `driveOpen.ts` / `DriveUi.tsx` (זרימה ו-UI), `config.ts` (קונפיגורציה מ-`/api/auth/providers`).
- `vercel.json`: rewrite `/drive/open` ← `/index.html` (השאילתה נשמרת). `middleware.ts` מגן על `/drive/open` כמו על כל דף אפליקציה, וה-`next` שומר את `?state=…` (עד 2048 תווים).
- `GET /api/auth/providers` מחזיר `googleClientId` (כשהכניסה עם Google מוגדרת) ו-`googlePickerApiKey` + `googleAppId` (כש-`GOOGLE_API_KEY` ו-`GOOGLE_PROJECT_NUMBER` מוגדרים) — ערכים ציבוריים בלבד.
- אסימון ה-Drive נשמר בזיכרון הדף בלבד (לא ב-localStorage ולא בשרת), ותקף כשעה.
- דפים ציבוריים: `/privacy.html`, `/terms.html` (עברית + אנגלית).
