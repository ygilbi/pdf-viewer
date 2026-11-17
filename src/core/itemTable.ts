import type { AreaMeasurement, Calibration, Category } from './types';
import {
  DEFAULT_CATEGORIES,
  UNCATEGORIZED_LABEL,
  categoryKey,
  categoryName,
  computeNetAreas,
  formatDetails,
  itemOf,
  kindOf,
  polylineLengthMeters,
  takeoffOnly,
} from './measurementEngine';

/**
 * טבלת פריטים — the owner's summary table: one row per item, grouped by category with a subtotal
 * per category. Columns (in this order): שם פריט · קטגוריה · מערכת · רוחב · גובה · מ״ר · כמות · מידע נוסף.
 * רוחב / גובה = one item's size in centimetres (a count group's item size, an area's bounding box).
 * מ״ר = the row's total area: a counted item's n × width × height, an area's net m² (lengths: none).
 * Every column except the category is free text; an empty field shows the automatic value.
 */
export const ITEM_COLUMNS = ['שם פריט', 'קטגוריה', 'מערכת', 'רוחב (ס״מ)', 'גובה (ס״מ)', 'מ״ר', 'כמות', 'מידע נוסף'] as const;

export type ItemUnit = 'יח׳' | 'מ״ר' | 'מ׳';

export interface ItemRow {
  id: string;
  page: number;
  kind: 'count' | 'area' | 'length';
  name: string;
  categoryKey: string;
  categoryName: string;
  system: string;
  /** Width / height of one item, display text in cm (user text or automatic). */
  width: string;
  height: string;
  /** The same in metres when numeric (null = unknown / free text). */
  widthM: number | null;
  heightM: number | null;
  /** Number used for subtotals (null = not measurable, e.g. uncalibrated page). */
  qty: number | null;
  unit: ItemUnit;
  /** Display text of the quantity cell ("12", "45.20 מ״ר", or the user's own text). */
  qtyText: string;
  /** Total area of the row in m² (null when unknown / not an area). */
  m2: number | null;
  extra: string;
  /** Which cells hold user text (vs automatic values) — the editor shows automatic ones as hints. */
  custom: { name: boolean; width: boolean; height: boolean; qty: boolean; extra: boolean };
}

export interface ItemSubtotal {
  units: number;
  m2: number;
  m: number;
}

export interface ItemGroup {
  key: string;
  name: string;
  color?: string;
  rows: ItemRow[];
  subtotal: ItemSubtotal;
}

export interface ItemTable {
  groups: ItemGroup[];
  total: ItemSubtotal;
  /** Rows on uncalibrated pages (area / length quantity unknown). */
  uncalibrated: number;
}

/** Count groups, areas and lengths are items (an area / length can be left out with `asItem: false`). */
export function isItem(m: AreaMeasurement): boolean {
  const k = kindOf(m);
  return k === 'count' || ((k === 'area' || k === 'length') && m.asItem !== false);
}

const trim = (s: unknown) => (typeof s === 'string' ? s.trim() : '');
const fix2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** "1,234.5" / "12 מ״ר" / "3,5" → number; null when the text has no number. */
export function parseQty(text: string): number | null {
  const m = /-?\d[\d,]*(?:[.,]\d+)?/.exec(text.replace(/\s/g, ''));
  if (!m) return null;
  let t = m[0];
  // "1,234.5" → thousands separator; "3,5" → decimal comma
  t = /,\d{3}(\D|$)/.test(t) && t.includes('.') ? t.replace(/,/g, '') : t.replace(',', '.');
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** cm number → display text ("150", "92.5"). */
const cmText = (meters: number) => String(Math.round(meters * 1000) / 10);

/**
 * The width / height the user typed for an item (cm text), or ''. Older saves have one "גודל"
 * cell (sizeText "120×200"): it is split into the two values.
 */
export function itemSizeText(m: Pick<AreaMeasurement, 'widthText' | 'heightText' | 'sizeText'>): { w: string; h: string } {
  const w = trim(m.widthText);
  const h = trim(m.heightText);
  if (w || h) return { w, h };
  const legacy = trim(m.sizeText);
  const x = /(\d+(?:[.,]\d+)?)\s*[x×X*]\s*(\d+(?:[.,]\d+)?)/.exec(legacy);
  if (x) return { w: x[1], h: x[2] };
  return { w: legacy, h: '' };
}

/** cm text → metres (null when not a positive number). */
const cmToM = (t: string): number | null => {
  const v = t ? parseQty(t) : null;
  return v != null && v > 0 ? v / 100 : null;
};

/** Bounding box of a polygon in metres. */
function bboxM(m: AreaMeasurement, ppm: number): { w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of m.points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return Number.isFinite(x0) ? { w: (x1 - x0) / ppm, h: (y1 - y0) / ppm } : null;
}

/** Bounding box of a polygon in CENTIMETRES (the size column is always cm): "400×940". */
export function bboxSize(m: AreaMeasurement, ppm: number): string {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of m.points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0)) return '';
  const cm = (v: number) => Math.round((v / ppm) * 100);
  return `${cm(x1 - x0)}×${cm(y1 - y0)}`;
}

/** Quantity-column subtotal: units and meters (m² has its own column). */
export const formatQtySubtotal = (t: ItemSubtotal): string => {
  const parts: string[] = [];
  if (t.units) parts.push(`${t.units} יח׳`);
  if (t.m) parts.push(`${fix2(t.m)} מ׳`);
  return parts.join(' · ');
};
export const formatM2 = (v: number | null | undefined): string => (v ? fix2(v) : '');

export const formatSubtotal = (t: ItemSubtotal): string => {
  const parts: string[] = [];
  if (t.units) parts.push(`${t.units} יח׳`);
  if (t.m2) parts.push(`${fix2(t.m2)} מ״ר`);
  if (t.m) parts.push(`${fix2(t.m)} מ׳`);
  return parts.join(' · ') || '—';
};

export function buildItemTable(
  all: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
  categories: Category[] = DEFAULT_CATEGORIES,
): ItemTable {
  const measurements = takeoffOnly(all);
  const nets = computeNetAreas(measurements, calibrations);
  const groups = new Map<string, ItemGroup>();
  const order = new Map(categories.map((c, i) => [c.id, i]));
  let uncalibrated = 0;
  const total: ItemSubtotal = { units: 0, m2: 0, m: 0 };

  for (const m of measurements) {
    if (!isItem(m)) continue;
    const kind = kindOf(m) as 'count' | 'area' | 'length';
    const cal = calibrations[m.page];
    const ppm = cal && cal.pixelsPerMeter > 0 ? cal.pixelsPerMeter : null;
    const it = itemOf(m);

    let autoQty: number | null;
    let unit: ItemUnit;
    let autoW: number | null = null; // metres
    let autoH: number | null = null;
    if (kind === 'count') {
      autoQty = m.points.length;
      unit = 'יח׳';
      if (it) {
        autoW = it.width;
        autoH = it.height;
      }
    } else if (kind === 'area') {
      unit = 'מ״ר';
      const net = nets.get(m.id);
      autoQty = net ? Math.round(net.netM2 * 100) / 100 : null;
      const bb = ppm ? bboxM(m, ppm) : null;
      if (bb) {
        autoW = bb.w;
        autoH = bb.h;
      }
    } else {
      unit = 'מ׳';
      autoQty = ppm ? Math.round(polylineLengthMeters(m.points, ppm) * 100) / 100 : null;
    }
    if (autoQty === null) uncalibrated++;

    const userQty = trim(m.qtyText);
    const qty = userQty ? parseQty(userQty) : autoQty;
    const qtyText = userQty || (autoQty === null ? 'לא מכויל' : kind === 'count' ? String(autoQty) : `${fix2(autoQty)} ${unit}`);

    const key = categoryKey(m);
    const userName = trim(m.itemName);
    const typed = itemSizeText(m);
    const widthM = typed.w ? cmToM(typed.w) : autoW;
    const heightM = typed.h ? cmToM(typed.h) : autoH;
    // A counted item with a size also adds its total area (n × w × h) to the m² column / subtotals.
    const extraM2 = kind === 'count' && widthM && heightM ? widthM * heightM * m.points.length : 0;
    const userExtra = trim(m.extra);
    const row: ItemRow = {
      id: m.id,
      page: m.page,
      kind,
      name: userName || it?.code || m.label,
      categoryKey: key,
      categoryName: key ? categoryName(key, categories) : UNCATEGORIZED_LABEL,
      system: trim(m.system),
      // Automatic: an item's schedule size to 0.1 cm, a measured area's bounding box to whole cm.
      width: typed.w || (autoW != null ? (kind === 'area' ? String(Math.round(autoW * 100)) : cmText(autoW)) : ''),
      height: typed.h || (autoH != null ? (kind === 'area' ? String(Math.round(autoH * 100)) : cmText(autoH)) : ''),
      widthM,
      heightM,
      qty,
      unit,
      qtyText,
      m2: kind === 'count' ? (extraM2 ? extraM2 : null) : kind === 'area' ? qty : null,
      extra: userExtra || formatDetails(m),
      custom: { name: !!userName, width: !!typed.w, height: !!typed.h, qty: !!userQty, extra: !!userExtra },
    };

    let g = groups.get(key);
    if (!g) {
      const cat = categories.find((c) => c.id === key);
      g = { key, name: row.categoryName, color: cat?.color, rows: [], subtotal: { units: 0, m2: 0, m: 0 } };
      groups.set(key, g);
    }
    g.rows.push(row);
    if (qty !== null) {
      const field = unit === 'יח׳' ? 'units' : unit === 'מ״ר' ? 'm2' : 'm';
      g.subtotal[field] += qty;
      total[field] += qty;
    }
    if (extraM2) {
      g.subtotal.m2 += extraM2;
      total.m2 += extraM2;
    }
  }

  const sorted = [...groups.values()].sort((a, b) => {
    const ia = a.key ? (order.get(a.key) ?? 1e6) : 2e6; // uncategorised last
    const ib = b.key ? (order.get(b.key) ?? 1e6) : 2e6;
    return ia - ib || a.name.localeCompare(b.name, 'he');
  });
  for (const g of sorted) g.rows.sort((a, b) => a.page - b.page || a.name.localeCompare(b.name, 'he', { numeric: true }));
  return { groups: sorted, total, uncalibrated };
}

/** Plain rows for CSV / Excel / PDF: header, then per category its rows + a subtotal row, then the total. */
export function itemTableRows(t: ItemTable): string[][] {
  const out: string[][] = [[...ITEM_COLUMNS]];
  for (const g of t.groups) {
    for (const r of g.rows) out.push([r.name, r.categoryName, r.system, r.width, r.height, formatM2(r.m2), r.qtyText, r.extra]);
    out.push([`סה״כ ${g.name}`, g.name, '', '', '', formatM2(g.subtotal.m2), formatQtySubtotal(g.subtotal), '']);
  }
  if (t.groups.length > 1) out.push(['סה״כ כללי', '', '', '', '', formatM2(t.total.m2), formatQtySubtotal(t.total), '']);
  return out;
}
