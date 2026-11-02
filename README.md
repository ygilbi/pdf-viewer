# PDF Viewer — מציג תוכניות PDF עם מדידת שטחי חזיתות

מציג PDF מהיר לקבצים כבדים (50MB+) עם כיול קנה מידה ומדידת שטח פוליגונים במ״ר.

## הרצה
```bash
npm install
npm run dev      # פיתוח
npm run build    # בנייה לפרודקשן (dist/)
npm test         # בדיקות מנוע המדידה
```

## ארכיטקטורה
- `src/core/pdfWorker.ts` — pdf.js רץ ב-Web Worker ומרנדר ל-OffscreenCanvas; תור עדיפויות, ביטול, מטמון דפים.
- `src/core/pdfClient.ts` — API יחיד לממשק; fallback לרינדור ב-main thread בדפדפנים ללא תמיכה.
- `src/core/measurementEngine.ts` — כיול (יחידות דף למטר), שטח Shoelace, היקף, ייצוא CSV.
- `src/components/ViewerCanvas.tsx` — pan/zoom ב-CSS transform (GPU), שכבת בסיס + שכבה חדה לאזור הנראה, שכבת SVG למדידות.
- `src/components/*` — סרגל כלים, תמונות ממוזערות וירטואליות, פאנל מדידות.

## קיצורי מקלדת
V/H הזזה · C כיול · A מדידת שטח · 0/F התאם לדף · +/- זום · PageUp/PageDown דפים ·
Enter סגירת פוליגון · Backspace מחיקת נקודה אחרונה · Esc ביטול · Delete מחיקת מדידה · Shift הצמדה ל-45° · רווח+גרירה הזזה

## כלים
הזזה (V) · כיול (C) · שטח חזית (A) · פתח לניכוי (D) · אורך (L) · ספירת פריטים (N) · קטגוריות · העתקת טבלה לאקסל · ייצוא CSV/JSON · שמירה אוטומטית בדפדפן (IndexedDB)

## פריסה
- **Vercel** (מומלץ, עובד גם עם מאגר פרטי): Import Project → בחירת המאגר → Deploy. ההגדרות ב-`vercel.json`.
- **GitHub Pages**: Settings → Pages → Source: GitHub Actions. כל push ל-`main` מריץ בדיקות ומפרסם (`.github/workflows/deploy-pages.yml`). במאגר פרטי דורש מנוי GitHub בתשלום.

## התקנה כאפליקציה ו-PDF ברירת מחדל ב-Windows
האפליקציה היא PWA עם File Handling API, כך שאפשר להתקין אותה ולפתוח איתה קובצי PDF ישירות מסייר הקבצים.

**התקנה**
1. פותחים את האתר ב-**Edge** או ב-**Chrome** (בכתובת HTTPS: Vercel או GitHub Pages).
2. לוחצים על אייקון ההתקנה בשורת הכתובת (מסך עם חץ ⊕), או על הכפתור "התקן כאפליקציה" בתוך האפליקציה, ומאשרים.
   ב-Edge אפשר גם: תפריט ⋯ → אפליקציות → התקן אתר זה כאפליקציה.

**הגדרה כברירת מחדל ל-PDF**

> **מגבלה:** Windows 10/11 (וגם macOS) אינם מאפשרים לשום תוכנה — רגילה או PWA — להגדיר את עצמה כברירת מחדל באופן אוטומטי. נדרש אישור של המשתמש בממשק המערכת, פעם אחת. מה שהאפליקציה עושה הוא לשאול בזמן הנכון ולהוביל את המשתמש לשם.

- **שאלה אוטומטית אחרי ההתקנה:** בהפעלה הראשונה של האפליקציה המותקנת (חלון עצמאי, לא לשונית) ב-Windows או ב-macOS נפתח חלון "הגדר את PDF Viewer כתוכנת ברירת המחדל לקובצי PDF":
  - ב-Windows: כפתור שפותח ישירות את **הגדרות → אפליקציות → אפליקציות ברירת מחדל** (`ms-settings:defaultapps`; הדפדפן שואל "לפתוח את הגדרות?" — מאשרים), ושלושה שלבים מאוירים שנשארים מוצגים: מקלידים `.pdf` בתיבת החיפוש → לוחצים על התוכנה הנוכחית → בוחרים "PDF Viewer" → **הגדר ברירת מחדל**. מוצגת גם הדרך החלופית (לחיצה ימנית → **פתח באמצעות** → **בחר אפליקציה אחרת** → "PDF Viewer" → **תמיד**).
  - ב-macOS: Finder → לחיצה ימנית על PDF → **קבל מידע** → **פתח באמצעות**: "PDF Viewer" → **שנה הכל…**.
  - כפתורים: **כבר הגדרתי** / **הזכר לי מאוחר יותר** (שוב אחרי יום; גם Esc/×) / **אל תשאל שוב**. הבחירה נשמרת ב-`localStorage` (`pdf-viewer:default-app:v1`).
  - אם האפליקציה נפתחה מתוך קובץ PDF (לחיצה כפולה / פתח באמצעות) — לא שואלים. אחרי 2 הפעלות כאלה מאפס האפליקציה מניחה שהיא כבר ברירת המחדל ומפסיקה לשאול.
  - בדפדפן (לא מותקן): אחרי ההתקנה מופיעה הודעה "האפליקציה הותקנה — פתח אותה מתפריט התחל כדי להגדיר כברירת מחדל".
- בכל זמן: תפריט עליון → **הגדר כברירת מחדל ל‑PDF** פותח את אותו חלון.
- כשהאפליקציה היא ברירת המחדל, סייר הקבצים מציג את קובצי ה-PDF עם סמל הקובץ מה-manifest (`file_handlers[].icons`).
- בפתיחה הראשונה של קובץ הדפדפן ישאל אם לאפשר לאפליקציה לפתוח קובצי PDF — מאשרים (אפשר לסמן "זכור").

**הערות**
- נדרש אירוח ב-HTTPS (Vercel / GitHub Pages; `localhost` עובד לבדיקה). פתיחת קבצים מהמערכת נתמכת בדפדפני Chromium (Edge/Chrome) ב-Windows, macOS, Linux ו-ChromeOS; Firefox ו-Safari אינם תומכים ב-File Handling.
- כשהאפליקציה כבר פתוחה, קובץ חדש נפתח באותו חלון (`launch_type: single-client`).
- Service Worker (בבנייה לפרודקשן בלבד) שומר את מעטפת האפליקציה במטמון: טעינות חוזרות מהירות ועבודה גם ללא רשת. קובצי CMap/גופנים של pdf.js נשמרים לפי דרישה.
- הקבצים: `public/manifest.webmanifest`, `public/icons/` (נוצרים ע״י `python3 scripts/make-icons.py`), `src/pwa/` (רישום SW, `useFileLaunch`, `<InstallButton/>`, `<DefaultAppPrompt/>` + לוגיקת ההחלטה ב-`defaultApp.ts`), ו-`sw.js` שנוצר בבנייה ע״י `src/pwa/swPlugin.ts`.

## כניסה וגישה (קוד למייל / טביעת אצבע)
האתר (האפליקציה וההורדה) פתוח למשתמשים מאושרים בלבד. שתי דרכי כניסה, בלי סיסמאות: **קוד חד-פעמי למייל** (לרוב המחשבים — אין בהם טביעת אצבע / מצלמה), או **מפתח גישה (Passkey / WebAuthn)** — טביעת אצבע, Face ID או Windows Hello.

- **`/download`** — הלוגו בלבד. ב-Windows הכפתור הראשי הוא **"הורד ל-Windows"** (→ `/api/download`) וקישור משני "או פתח בדפדפן — ללא התקנה" (→ `/`); בשאר המכשירים הפוך: **"פתח את PDF Viewer בדפדפן — ללא התקנה"** וקישור "הורדה ל-Windows". זיהוי Windows: `detectOs()` (UA-CH ואז UA).
- **`/login`** (`login.html`, `src/login/`):
  - שתי אפשרויות שוות: **"כניסה עם קוד למייל"** ו-**"כניסה עם טביעת אצבע / זיהוי פנים / Windows Hello"**. הראשית היא מפתח הגישה רק כש-`platformAuthenticatorIsAvailable()`; אחרת הקוד למייל.
  - **קוד למייל**: אימייל → "שלח קוד" (`POST /api/auth/email/start`) → שדה 6 ספרות (`inputmode=numeric`, `autocomplete=one-time-code`, הדבקה, שליחה אוטומטית ב-6 ספרות) → `POST /api/auth/email/verify` → `?next=`. "שלח שוב" עם ספירה לאחור (30 ש׳ / `retryAfter`), הודעת "נותרו N ניסיונות" (`attemptsLeft`), קוד שפג / נחסם → "שלח קוד חדש". הכתובת האחרונה נשמרת ב-`localStorage` (`pdf-viewer:last-email`). כתובת לא רשומה → "בקש גישה".
  - **מפתח גישה**: `startAuthentication` מול `POST /api/auth/login/options|verify`. אין מפתח במכשיר? "טלפון או טאבלט" וסריקת QR.
  - `?next=` — רק נתיב יחסי באותו אתר (`safeNext()` ב-`src/auth/api.ts`; ברירת מחדל `/`).
  - **משתמש חדש? בקש גישה** — שם + אימייל → `POST /api/auth/request`. בעל האתר מאשר במייל, והמשתמש מקבל קישור חד-פעמי `…/login?invite=<token>`.
  - **רישום** (`?invite=`) — "שלום <שם>!" ושתי אפשרויות: **רשום טביעת אצבע / זיהוי פנים / Windows Hello** (`register/options|verify`) או **המשך עם קוד במייל (בלי טביעת אצבע)** (`POST /api/auth/register/email`). בשני המקרים → `/welcome`. קישור שפג / שומש → "בקש גישה מחדש".
  - שגיאות `server_config` / `mail_failed` מציגות קישור **"בדיקת הגדרות השרת"** ל-`/api/health`.
- **`/welcome`** (`welcome.html`, `src/welcome/`; חסום ב-middleware, והלקוח בודק `auth/me` → 401 מפנה ל-`/login?next=/welcome`): "ברוך/ה הבא/ה, <שם>!", כפתור ראשי **"כניסה לאפליקציה"**, ואוטומטית (כשלא רצים כאפליקציה מותקנת):
  - כרטיס **התקנה כאפליקציה בדפדפן** — חלון ההתקנה של הדפדפן (`beforeinstallprompt`, `src/pwa/installPrompt.ts`), או הוראות קצרות לפי דפדפן (iOS: שיתוף ← "הוסף למסך הבית"; Chrome/Edge: סמל ההתקנה בשורת הכתובת; Safari ב-Mac: קובץ ← הוסף ל-Dock; Firefox: לפתוח ב-Chrome/Edge). אחרי `appinstalled` — **"הגדר כברירת מחדל לקובצי PDF"** עם השלבים ל-Windows / macOS.
  - ב-Windows (לא בתוך תוכנת שולחן העבודה): **"הורד את התוכנה ל-Windows (מומלץ)"** → `/api/download`, עם הערה על SmartScreen ("More info" ← "Run anyway").
  - חשבון בלי מפתח גישה (`hasPasskey: false`) במכשיר עם טביעת אצבע / Windows Hello: כרטיס אופציונלי **"הוסף כניסה מהירה"** (`POST /api/auth/passkey/add/options|verify`).
- **שער באפליקציה** (`src/auth/session.ts`): בטעינה `GET /api/auth/me` (מוצג לוגו בזמן הבדיקה); 401 → `/login?next=<הדף הנוכחי>`. ללא רשת / שגיאת שרת — האפליקציה נפתחת (שימוש offline ב-PWA; ה-middleware בשרת מגן בכל מקרה). לא פועל בגרסת שולחן העבודה (Electron) וב-`npm run dev` (אלא אם `VITE_AUTH=1`). בתפריט העליון: שם המשתמש ו-**התנתק**.
- ה-Service Worker אינו מיירט את `/login`, `/download`, `/welcome` ו-`/api/*`.
- צד הלקוח: `@simplewebauthn/browser`; עטיפות ה-fetch ובדיקות: `src/auth/api.ts`, `src/auth/api.test.ts`; רכיבי UI משותפים: `src/auth/ui.tsx`.

## גרסת Windows (מתקין)
בנוסף ל-PWA יש גרסת שולחן עבודה ל-Windows (Electron, תיקיית `desktop/`) עם מתקין NSIS רגיל.

**הורדה והתקנה**
1. נכנסים לעמוד **`/download`** באתר (גם מהאפליקציה: תפריט עליון → **הורד גרסת Windows**, מוצג רק בדפדפן ב-Windows) ולוחצים **הורדה ל-Windows** (`/api/download`). ההורדה דורשת כניסה — מי שאינו מחובר מועבר ל-`/login` (ראו "כניסה וגישה" למטה) וחוזר להורדה אחרי הכניסה.
2. משתמש חדש מבקש גישה בעמוד `/login`; אחרי אישור בעל האתר הוא מקבל מייל עם קישור רישום חד-פעמי. אין קישור ציבורי ישיר למתקין.
3. מפעילים את הקובץ. ההתקנה היא למשתמש הנוכחי בלבד ואינה דורשת הרשאות מנהל.
4. **SmartScreen:** המתקין אינו חתום דיגיטלית, ולכן ייתכן שיופיע "Windows protected your PC" — לוחצים **More info** (מידע נוסף) ← **Run anyway** (הפעל בכל זאת).

**מה המתקין עושה אוטומטית**
- מתקין את `PDFViewer.exe` ויוצר קיצור דרך בתפריט התחל.
- רושם את סוג הקובץ `PDFViewer.Document` (פקודת פתיחה + סמל קובץ PDF מ-`resources\file-pdf.ico`), מוסיף אותו ל-"פתח באמצעות" של `.pdf`, ורושם את התוכנה ב-`RegisteredApplications` כך שתופיע ברשימת אפליקציות ברירת המחדל של Windows.
- **אינו** פותח את הגדרות Windows בסוף ההתקנה — השאלה נשאלת פעם אחת, בתוך התוכנה (ראו למטה).

**שאלה אחת בלבד: ברירת מחדל ל-PDF**
Windows 10/11 אינה מאפשרת לתוכנה להגדיר את עצמה כברירת מחדל — נדרש אישור של המשתמש. לכן בהפעלה הראשונה אחרי ההתקנה התוכנה שואלת **פעם אחת**: "להפוך את PDF Viewer לתוכנת ברירת המחדל לקובצי PDF?"
- **כן, הגדר** — נפתח עמוד ההגדרות של PDF Viewer (`ms-settings:defaultapps?registeredAppUser=PDF%20Viewer`) עם הנחיה קצרה: בוחרים **PDF Viewer** עבור `.pdf` ← **הגדר ברירת מחדל**. החלון נסגר מעצמו כש-Windows מדווחת שההגדרה נקלטה (בדיקת `UserChoice` ברישום, רק בזמן שההנחיה פתוחה), או בלחיצה על **סיימתי**.
- **לא, תודה** (וגם Esc / ×) — לא נשאל שוב.
- אם PDF Viewer כבר ברירת המחדל בהפעלה הראשונה — לא שואלים כלל.
- התשובה נשמרת בקובץ `%APPDATA%\PDF Viewer\prefs.json` (`{"defaultPdfPrompt": {"answered": true, "answer": "yes|no|already-default", "at": …}}`) ולא ב-`localStorage`. הקובץ נכתב רק אחרי תשובה — סגירת התוכנה בלי לענות תציג את השאלה שוב בהפעלה הבאה.
- הסרה והתקנה מחדש **לא** מוחקות את הקובץ (`deleteAppDataOnUninstall: false`), כך שהשאלה נשאלת פעם אחת לכל משתמש Windows. כדי לשאול שוב: מוחקים את `prefs.json`.
- בכל זמן: תפריט עליון ← **הגדר כברירת מחדל ל‑PDF** פותח את אותו חלון.
- לחלופין: לחיצה ימנית על PDF ← **פתח באמצעות** ← **בחר אפליקציה אחרת** ← PDF Viewer ← **תמיד**.

**הסרה**
הגדרות ← אפליקציות ← אפליקציות מותקנות ← **PDF Viewer** ← **הסר התקנה**. ההסרה מוחקת גם את רישומי סוג הקובץ מהרישום.

**בנייה ו-CI**
- `.github/workflows/desktop-windows.yml` רץ על `windows-latest`: בונה את האתר ל-`desktop/web-dist`, בונה את המתקין, ומריץ בדיקת עשן (`desktop/test/smoke.ps1`): התקנה שקטה (`/S`), בדיקת מפתחות הרישום וקובץ הסמל, וידוא שהמתקין לא פתח את ההגדרות, הפעלת התוכנה עם `public/demo-facade.pdf` וצילום מסך, הפעלה נוספת עם `PDF_VIEWER_CAPTURE` שמוודאת שחלון השאלה החד-פעמית מוצג (`first-run-default-dialog.png`) ושה-`prefs.json` לא נכתב לפני תשובה, והסרה שקטה. לפני הבנייה צעד `grep` מוודא ש-`installer.nsh` לא מפעיל שום דבר (`ExecShell` / `ms-settings`) ושהרישומים קיימים. המתקין וצילומי המסך נשמרים כ-artifacts של הריצה.
- פרסום Release: דוחפים תג `desktop-v<גרסה>` (למשל `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`), או Actions ← **Desktop (Windows installer)** ← **Run workflow** עם `release` מסומן.
- בנייה מקומית ב-Windows: `npm ci && npm --prefix desktop ci && npm --prefix desktop run dist`; בדיקת עשן מקומית: `powershell -ExecutionPolicy Bypass -File desktop\test\smoke.ps1`.
- פיתוח: `npm --prefix desktop run build:web && npm --prefix desktop start -- path\to\file.pdf`. האפליקציה מגישה את `desktop/web-dist` מ-`app://pdf-viewer/` (ללא service worker), ומעבירה קובצי PDF משורת הפקודה / מופע שני ל-`window.pdfDesktop` (`src/desktop/bridge.ts`).
- סמלים: `python3 desktop/scripts/make-icons.py` יוצר את `desktop/build/icon.ico` (16–256) ומעתיק את `file-pdf.ico` מ-`public/icons/`. הגדרות המתקין ורישומי הרישום: `desktop/package.json` (`build`) ו-`desktop/build/installer.nsh`.
- אין עדכון אוטומטי עדיין — גרסה חדשה מותקנת ע"י הרצת המתקין החדש (מעדכן במקום).
