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

## גרסת Windows (מתקין)
בנוסף ל-PWA יש גרסת שולחן עבודה ל-Windows (Electron, תיקיית `desktop/`) עם מתקין NSIS רגיל.

**הורדה והתקנה**
1. נכנסים לעמוד **`/download`** באתר (גם מהאפליקציה: תפריט עליון → **הורד גרסת Windows**, מוצג רק בדפדפן ב-Windows) וממלאים בקשת הורדה: שם מלא, אימייל, ואופציונלית חברה ומטרה.
2. ההורדה מאושרת ידנית: בעל האתר מקבל מייל עם הבקשה ומאשר אותה, ואז המבקש מקבל מייל עם **קישור הורדה אישי** ל-`PDF-Viewer-Setup-<גרסה>.exe`. הקישור תקף לכמה ימים בלבד; אחרי שפג תוקפו שולחים בקשה חדשה. אין קישור ציבורי ישיר למתקין.
3. מפעילים את הקובץ. ההתקנה היא למשתמש הנוכחי בלבד ואינה דורשת הרשאות מנהל.
4. **SmartScreen:** המתקין אינו חתום דיגיטלית, ולכן ייתכן שיופיע "Windows protected your PC" — לוחצים **More info** (מידע נוסף) ← **Run anyway** (הפעל בכל זאת).

**מה המתקין עושה אוטומטית**
- מתקין את `PDFViewer.exe` ויוצר קיצור דרך בתפריט התחל.
- רושם את סוג הקובץ `PDFViewer.Document` (פקודת פתיחה + סמל קובץ PDF מ-`resources\file-pdf.ico`), מוסיף אותו ל-"פתח באמצעות" של `.pdf`, ורושם את התוכנה ב-`RegisteredApplications` כך שתופיע ברשימת אפליקציות ברירת המחדל של Windows.
- בסיום פותח את עמוד **הגדרות ← אפליקציות ← אפליקציות ברירת מחדל** של PDF Viewer.

**האישור החד-פעמי ש-Windows דורשת**
Windows 10/11 אינה מאפשרת לתוכנה להגדיר את עצמה כברירת מחדל. בעמוד ההגדרות שנפתח בוחרים את **PDF Viewer** עבור `.pdf` (ב-Windows 11: לוחצים על השורה `.pdf` ← PDF Viewer ← **הגדר ברירת מחדל**). לחלופין: לחיצה ימנית על PDF ← **פתח באמצעות** ← **בחר אפליקציה אחרת** ← PDF Viewer ← **תמיד**. זה נעשה פעם אחת בלבד.

**הסרה**
הגדרות ← אפליקציות ← אפליקציות מותקנות ← **PDF Viewer** ← **הסר התקנה**. ההסרה מוחקת גם את רישומי סוג הקובץ מהרישום.

**בנייה ו-CI**
- `.github/workflows/desktop-windows.yml` רץ על `windows-latest`: בונה את האתר ל-`desktop/web-dist`, בונה את המתקין, ומריץ בדיקת עשן (`desktop/test/smoke.ps1`): התקנה שקטה (`/S`), בדיקת מפתחות הרישום וקובץ הסמל, הפעלת התוכנה עם `public/demo-facade.pdf` וצילום מסך, והסרה שקטה. המתקין וצילום המסך נשמרים כ-artifacts של הריצה.
- פרסום Release: דוחפים תג `desktop-v<גרסה>` (למשל `git tag desktop-v0.1.0 && git push origin desktop-v0.1.0`), או Actions ← **Desktop (Windows installer)** ← **Run workflow** עם `release` מסומן.
- בנייה מקומית ב-Windows: `npm ci && npm --prefix desktop ci && npm --prefix desktop run dist`; בדיקת עשן מקומית: `powershell -ExecutionPolicy Bypass -File desktop\test\smoke.ps1`.
- פיתוח: `npm --prefix desktop run build:web && npm --prefix desktop start -- path\to\file.pdf`. האפליקציה מגישה את `desktop/web-dist` מ-`app://pdf-viewer/` (ללא service worker), ומעבירה קובצי PDF משורת הפקודה / מופע שני ל-`window.pdfDesktop` (`src/desktop/bridge.ts`).
- סמלים: `python3 desktop/scripts/make-icons.py` יוצר את `desktop/build/icon.ico` (16–256) ומעתיק את `file-pdf.ico` מ-`public/icons/`. הגדרות המתקין ורישומי הרישום: `desktop/package.json` (`build`) ו-`desktop/build/installer.nsh`.
- אין עדכון אוטומטי עדיין — גרסה חדשה מותקנת ע"י הרצת המתקין החדש (מעדכן במקום).
