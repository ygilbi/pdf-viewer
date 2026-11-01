# Aluminum App — מציג תוכניות PDF עם מדידת שטחי חזיתות

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
