import { useViewer } from '../state/store';
import { persistentMeasurements } from '../core/tempMeasurements';
import { buildGilboaPayload, gilboaImportUrl, normalizeGilboaBase } from '../core/gilboaExport';

const KEY = 'gilboa-app-url';

function savedBase(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * "שלח לגלבוע" (top bar, edit mode): פותח את מסך הייבוא באפליקציית גלבוע ייעוץ אלומיניום עם כל המדידות (כולל מידות מדויקות),
 * ושם בוחרים פרויקט ולוחצים "ייבא" – הפריטים נכנסים לרשימת הפריטים של הפרויקט.
 * כתובת האפליקציה נשאלת פעם אחת ונשמרת (אפשר לשנות בלחיצה ארוכה / Shift+לחיצה).
 */
export function sendToGilboa(e?: { shiftKey?: boolean }): void {
  let base = e?.shiftKey ? null : savedBase();
  if (!base) {
    const typed = window.prompt('כתובת אפליקציית גלבוע (למשל https://aluminum-app.vercel.app)', savedBase() ?? 'https://');
    if (typed == null) return;
    base = normalizeGilboaBase(typed);
    if (!base) {
      window.alert('כתובת לא תקינה – צריך כתובת https של אפליקציית גלבוע');
      return;
    }
    try {
      localStorage.setItem(KEY, base);
    } catch {
      /* לא נשמר – יישאל שוב בפעם הבאה */
    }
  }
  const s = useViewer.getState();
  // Temporary view-mode quick measurements are never sent.
  const url = gilboaImportUrl(base, buildGilboaPayload(persistentMeasurements(s.measurements), s.calibrations, s.categories, s.fileName));
  // נפתח מתוך הלחיצה עצמה – כדי שהדפדפן לא יחסום את החלון
  const w = window.open(url, '_blank', 'noopener');
  if (!w) window.location.href = url;
}
