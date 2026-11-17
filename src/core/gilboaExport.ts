import type { AreaMeasurement, Calibration, Category } from './types';
import { itemSizeText } from './itemTable';
import { categoryKey, categoryName, itemOf, kindOf, polygonAreaM2, polygonPerimeterMeters, polylineLengthMeters } from './measurementEngine';

/**
 * "שלח לגלבוע": המדידות → חבילה לאפליקציית גלבוע ייעוץ אלומיניום (ייבוא פריטים לפרויקט).
 * לכל מדידה: סוג, שם, קטגוריה, עמוד, שטח / היקף / אורך / כמות, ומידות מדויקות (רוחב × גובה לפי המלבן החוסם).
 * החבילה עוברת בכתובת: <אפליקציית גלבוע>/import-takeoff#takeoff=<base64url של JSON>.
 */
export interface GilboaMeasure {
  kind: 'area' | 'deduct' | 'length' | 'count';
  label: string;
  category: string;
  page: number;
  areaM2: number | null;
  perimeterM: number | null;
  lengthM: number | null;
  count: number | null;
  widthM: number | null;
  heightM: number | null;
}

export interface GilboaPayload {
  v: 1;
  source: 'pdf-takeoff';
  file: string | null;
  measurements: GilboaMeasure[];
}

const GILBOA_KINDS: ReadonlySet<GilboaMeasure['kind']> = new Set(['area', 'deduct', 'length', 'count']);

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** "120×200" / "120x200" / "120 * 200" (centimetres, as in the items table's size column) → metres. */
export function parseSizeCm(text: string | undefined): { w: number; h: number } | null {
  const m = /(\d+(?:[.,]\d+)?)\s*[x×X*]\s*(\d+(?:[.,]\d+)?)/.exec(text ?? '');
  if (!m) return null;
  const w = Number(m[1].replace(',', '.')) / 100;
  const h = Number(m[2].replace(',', '.')) / 100;
  return w > 0 && h > 0 ? { w, h } : null;
}

const trim = (s: unknown) => (typeof s === 'string' ? s.trim() : '');

export function buildGilboaPayload(
  measurements: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
  categories: Category[],
  fileName: string | null,
): GilboaPayload {
  return {
    v: 1,
    source: 'pdf-takeoff',
    file: fileName,
    // Takeoff quantities only (markup / document edits are not items for the Gilboa app).
    measurements: measurements.filter((m) => GILBOA_KINDS.has(kindOf(m) as GilboaMeasure['kind'])).map((m) => {
      const kind = kindOf(m) as GilboaMeasure['kind'];
      const ppm = calibrations[m.page]?.pixelsPerMeter ?? null;
      const key = categoryKey(m);
      const it = itemOf(m);
      const out: GilboaMeasure = {
        kind,
        // The items table's name (user text, else the schedule code, else the label).
        label: trim(m.itemName) || it?.code || m.label,
        category: key ? categoryName(key, categories) : '',
        page: m.page,
        areaM2: null,
        perimeterM: null,
        lengthM: null,
        count: kind === 'count' ? m.points.length : null,
        widthM: null,
        heightM: null,
      };
      if (ppm && kind !== 'count') {
        if (kind === 'length') out.lengthM = r3(polylineLengthMeters(m.points, ppm));
        else {
          out.areaM2 = r3(polygonAreaM2(m.points, ppm));
          out.perimeterM = r3(polygonPerimeterMeters(m.points, ppm));
          const xs = m.points.map((p) => p.x);
          const ys = m.points.map((p) => p.y);
          out.widthM = r3((Math.max(...xs) - Math.min(...xs)) / ppm);
          out.heightM = r3((Math.max(...ys) - Math.min(...ys)) / ppm);
        }
      }
      if (kind === 'count' && it) {
        // Counted item with a size (W1 150×140): width, height and the area of ONE item.
        out.widthM = r3(it.width);
        out.heightM = r3(it.height);
        out.areaM2 = r3(it.width * it.height);
      }
      // A size typed in the items table wins (it is what the estimator decided).
      const t = itemSizeText(m);
      const typed = parseSizeCm(t.w && t.h ? `${t.w}×${t.h}` : m.sizeText);
      if (typed && (kind === 'count' || kind === 'deduct' || kind === 'area')) {
        out.widthM = r3(typed.w);
        out.heightM = r3(typed.h);
        if (kind === 'count' || out.areaM2 == null) out.areaM2 = r3(typed.w * typed.h);
      }
      return out;
    }),
  };
}

/** base64url של JSON (UTF-8 – עברית נשמרת) */
export function encodePayload(p: GilboaPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(p));
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** כתובת מסך הייבוא באפליקציית גלבוע */
export function gilboaImportUrl(base: string, p: GilboaPayload): string {
  return `${base.replace(/\/+$/, '')}/import-takeoff#takeoff=${encodePayload(p)}`;
}

/** כתובת האפליקציה – בדיקה בסיסית (https, או localhost לבדיקות) */
export function normalizeGilboaBase(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null;
    return `${u.origin}`;
  } catch {
    return null;
  }
}
