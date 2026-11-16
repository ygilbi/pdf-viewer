import { gilboaImportUrl, normalizeGilboaBase, type GilboaPayload } from '../core/gilboaExport';

const KEY = 'gilboa-app-url';

function savedBase(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * "פתח ב-ALOO" (export dialog → ALOO): opens ALOO's import screen with the items (exact sizes)
 * in the address (#takeoff=…); there the project is chosen and "ייבא" adds them as items.
 * ALOO's address is asked once and saved (Shift+click changes it).
 */
export function sendToAloo(payload: GilboaPayload, e?: { shiftKey?: boolean }): void {
  let base = e?.shiftKey ? null : savedBase();
  if (!base) {
    const typed = window.prompt('כתובת ALOO (למשל https://aluminum-app.vercel.app)', savedBase() ?? 'https://');
    if (typed == null) return;
    base = normalizeGilboaBase(typed);
    if (!base) {
      window.alert('כתובת לא תקינה – צריך כתובת https של ALOO');
      return;
    }
    try {
      localStorage.setItem(KEY, base);
    } catch {
      /* not saved — asked again next time */
    }
  }
  const url = gilboaImportUrl(base, payload);
  // Opened from the click itself, so the browser does not block the window.
  const w = window.open(url, '_blank', 'noopener');
  if (!w) window.location.href = url;
}
