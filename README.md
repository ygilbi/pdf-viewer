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
- לחיצה ימנית על קובץ PDF → **פתח באמצעות** → **בחר אפליקציה אחרת** → בוחרים "Aluminum PDF Takeoff" → **תמיד**.
- או: הגדרות → אפליקציות → אפליקציות ברירת מחדל → מקלידים `.pdf` → בוחרים "Aluminum PDF Takeoff".
- בפתיחה הראשונה הדפדפן ישאל אם לאפשר לאפליקציה לפתוח קובצי PDF — מאשרים (אפשר לסמן "זכור").

**הערות**
- נדרש אירוח ב-HTTPS (Vercel / GitHub Pages; `localhost` עובד לבדיקה). פתיחת קבצים מהמערכת נתמכת בדפדפני Chromium (Edge/Chrome) ב-Windows, macOS, Linux ו-ChromeOS; Firefox ו-Safari אינם תומכים ב-File Handling.
- כשהאפליקציה כבר פתוחה, קובץ חדש נפתח באותו חלון (`launch_type: single-client`).
- Service Worker (בבנייה לפרודקשן בלבד) שומר את מעטפת האפליקציה במטמון: טעינות חוזרות מהירות ועבודה גם ללא רשת. קובצי CMap/גופנים של pdf.js נשמרים לפי דרישה.
- הקבצים: `public/manifest.webmanifest`, `public/icons/` (נוצרים ע״י `python3 scripts/make-icons.py`), `src/pwa/` (רישום SW, `useFileLaunch`, `<InstallButton/>`), ו-`sw.js` שנוצר בבנייה ע״י `src/pwa/swPlugin.ts`.
