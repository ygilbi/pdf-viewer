import type { AreaMeasurement, Calibration, Category } from './types';
import { categoryKey, categoryName, kindOf, polygonAreaM2, polygonPerimeterMeters, polylineLengthMeters } from './measurementEngine';

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
      const out: GilboaMeasure = {
        kind,
        label: m.label,
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
