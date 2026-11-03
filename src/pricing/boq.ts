/**
 * Price book + bill of quantities (כתב כמויות) — pure calculation, no React.
 *
 * Quantity of a category line depends on its pricing unit:
 *   מ״ר  net facade area (openings already deducted) + item area (n×w×h of
 *        count groups with item dimensions) + openings that carry their own
 *        category different from the facade they sit in (e.g. windows drawn
 *        as deductions inside a cladding facade are priced as windows)
 *   מ׳   polyline length + frame / profile length (n×2(w+h))
 *   יח׳  number of counted items
 * The unit defaults to the category's dominant measurement kind (overridable).
 *
 * Money: quantity (2 dp) → × (1 + waste%) rounded to 2 dp → × (unit price +
 * labour) rounded to 2 dp. Subtotal, discount, VAT and total are each rounded
 * to 2 dp — the Excel export writes the same arithmetic as live formulas.
 * Measurements on uncalibrated pages carry no area / length and are reported
 * in `warnings` (counts need no calibration).
 */
import type { AreaMeasurement, Calibration, Category } from '../core/types';
import {
  assignDeductions,
  categoryKey,
  categoryName,
  computeCategorySummaries,
  computeDocumentSummary,
  kindOf,
  polygonAreaM2,
  takeoffOnly,
  type MeasurementSummary,
} from '../core/measurementEngine';

export type PriceUnit = 'm2' | 'm' | 'unit';

export const PRICE_UNITS: readonly PriceUnit[] = ['m2', 'm', 'unit'];

export const UNIT_LABELS: Record<PriceUnit, string> = { m2: 'מ״ר', m: 'מ׳', unit: 'יח׳' };

/** Price-book entry of one category. Missing fields = not set (unit: auto). */
export interface CategoryPrice {
  unit?: PriceUnit;
  /** Material / supply price per unit (currency). */
  price?: number;
  /** Waste / פחת in percent (10 = 10%). */
  wastePct?: number;
  /** Optional labour / installation price per unit. */
  labour?: number;
}

export interface PricingSettings {
  vatPct: number;
  discountPct: number;
  currency: string;
  projectName: string;
  client: string;
}

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  vatPct: 18,
  discountPct: 0,
  currency: '₪',
  projectName: '',
  client: '',
};

/** A price book layer (global book in localStorage, or per-document overrides). */
export interface PriceBook {
  /** Keyed by category id ('' = uncategorised). */
  categories: Record<string, CategoryPrice>;
  settings: Partial<PricingSettings>;
}

export const emptyPriceBook = (): PriceBook => ({ categories: {}, settings: {} });

export interface ResolvedPricing {
  categories: Record<string, CategoryPrice>;
  settings: PricingSettings;
}

/** Field-wise merge: document overrides win over the global book, defaults fill the rest. */
export function resolvePricing(global: PriceBook, doc: PriceBook): ResolvedPricing {
  const categories: Record<string, CategoryPrice> = {};
  for (const k of new Set([...Object.keys(global.categories), ...Object.keys(doc.categories)])) {
    categories[k] = { ...global.categories[k], ...doc.categories[k] };
  }
  return { categories, settings: { ...DEFAULT_PRICING_SETTINGS, ...global.settings, ...doc.settings } };
}

const finiteNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Sanitise a stored price book (tolerant of garbage); null when unusable. */
export function sanitizePriceBook(v: unknown): PriceBook | null {
  if (!v || typeof v !== 'object') return null;
  const { categories, settings } = v as Record<string, unknown>;
  const out = emptyPriceBook();
  if (categories && typeof categories === 'object') {
    for (const [k, raw] of Object.entries(categories as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const c: CategoryPrice = {};
      if (typeof r.unit === 'string' && (PRICE_UNITS as readonly string[]).includes(r.unit)) c.unit = r.unit as PriceUnit;
      if (finiteNonNeg(r.price)) c.price = r.price;
      if (finiteNonNeg(r.wastePct)) c.wastePct = r.wastePct;
      if (finiteNonNeg(r.labour)) c.labour = r.labour;
      if (Object.keys(c).length) out.categories[k] = c;
    }
  }
  if (settings && typeof settings === 'object') {
    const s = settings as Record<string, unknown>;
    if (finiteNonNeg(s.vatPct)) out.settings.vatPct = s.vatPct;
    if (finiteNonNeg(s.discountPct) && s.discountPct <= 100) out.settings.discountPct = s.discountPct;
    if (typeof s.currency === 'string' && s.currency.trim()) out.settings.currency = s.currency.trim().slice(0, 8);
    if (typeof s.projectName === 'string') out.settings.projectName = s.projectName.slice(0, 200);
    if (typeof s.client === 'string') out.settings.client = s.client.slice(0, 200);
  }
  return out;
}

/** Round half away from zero to 2 decimals (like Excel's ROUND(x, 2), tolerant of binary noise: 1.005 → 1.01). */
export function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const r = (Math.sign(v) * Math.round(Math.abs(v) * 100 * (1 + 1e-12))) / 100;
  return r === 0 ? 0 : r; // no -0
}

export interface BoqBreakdown {
  /** Net facade area of the category (m²). */
  netM2: number;
  /** Openings with their own category, outside a facade of that category (m²). */
  openingsM2: number;
  /** Σ n×w×h of count groups with item dimensions (m²). */
  itemAreaM2: number;
  lengthM: number;
  /** Σ n×2(w+h) (m). */
  itemPerimeterM: number;
  count: number;
}

export interface BoqLine {
  /** Category key ('' = uncategorised). */
  category: string;
  name: string;
  color?: string;
  unit: PriceUnit;
  /** True when the unit was picked automatically (no override in the price book). */
  unitIsAuto: boolean;
  /** Net quantity in `unit` (2 dp). */
  quantity: number;
  wastePct: number;
  /** quantity × (1 + waste%) (2 dp). */
  quantityWithWaste: number;
  unitPrice: number;
  labourPrice: number;
  /** quantityWithWaste × (unitPrice + labourPrice) (2 dp). */
  total: number;
  breakdown: BoqBreakdown;
  /** Area / length measurements of this category on uncalibrated pages (not included). */
  uncalibrated: number;
}

export interface Boq {
  lines: BoqLine[];
  subtotal: number;
  discountPct: number;
  /** Positive amount subtracted from the subtotal. */
  discount: number;
  afterDiscount: number;
  vatPct: number;
  vat: number;
  total: number;
  currency: string;
  projectName: string;
  client: string;
  /** Measurements on uncalibrated pages (excluded from every area / length quantity). */
  uncalibrated: number;
  /** Lines with a quantity but no price. */
  unpriced: number;
  warnings: string[];
}

export interface BoqInput {
  measurements: AreaMeasurement[];
  calibrations: Record<number, Calibration>;
  categories: Category[];
  pricing: ResolvedPricing;
  /** Only measurements on these (global) pages; omitted = all pages. */
  pages?: Iterable<number>;
}

/** Quantity of a breakdown in a unit (unrounded). */
export function quantityIn(unit: PriceUnit, b: BoqBreakdown): number {
  if (unit === 'm2') return b.netM2 + b.openingsM2 + b.itemAreaM2;
  if (unit === 'm') return b.lengthM + b.itemPerimeterM;
  return b.count;
}

/** Unit of the dominant measurement kind of a category (ties: m² > m′ > units). */
export function autoUnit(kinds: { area: number; length: number; count: number }): PriceUnit {
  if (kinds.area >= kinds.length && kinds.area >= kinds.count) return 'm2';
  return kinds.length >= kinds.count ? 'm' : 'unit';
}

/** Human-readable source of a line's quantity, e.g. "נטו 320.50 מ״ר + פריטים 25.20 מ״ר". */
export function describeQuantity(unit: PriceUnit, b: BoqBreakdown): string {
  const f = (v: number) => round2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parts: string[] = [];
  if (unit === 'm2') {
    if (b.netM2) parts.push(`נטו ${f(b.netM2)}`);
    if (b.openingsM2) parts.push(`פתחים ${f(b.openingsM2)}`);
    if (b.itemAreaM2) parts.push(`פריטים ${f(b.itemAreaM2)}`);
  } else if (unit === 'm') {
    if (b.lengthM) parts.push(`אורך ${f(b.lengthM)}`);
    if (b.itemPerimeterM) parts.push(`פרופיל ${f(b.itemPerimeterM)}`);
  } else if (b.count) parts.push(`${b.count} פריטים`);
  return parts.join(' + ');
}

const isEmpty = (b: BoqBreakdown) =>
  !b.netM2 && !b.openingsM2 && !b.itemAreaM2 && !b.lengthM && !b.itemPerimeterM && !b.count;

export function buildBoq(input: BoqInput): Boq {
  const { calibrations, categories, pricing } = input;
  const pageSet = input.pages ? new Set(input.pages) : null;
  const ms = takeoffOnly(pageSet ? input.measurements.filter((m) => pageSet.has(m.page)) : input.measurements);
  const settings = pricing.settings;

  // Openings priced in their own category (category set and ≠ the facade's).
  const assignment = assignDeductions(ms);
  const byId = new Map(ms.map((m) => [m.id, m]));
  const ownOpenings = new Map<string, number>();
  const kindCounts = new Map<string, { area: number; length: number; count: number }>();
  const kc = (k: string) => {
    let v = kindCounts.get(k);
    if (!v) kindCounts.set(k, (v = { area: 0, length: 0, count: 0 }));
    return v;
  };
  for (const m of ms) {
    const k = categoryKey(m);
    const kind = kindOf(m);
    if (kind === 'area') kc(k).area++;
    else if (kind === 'length') kc(k).length++;
    else if (kind === 'count') kc(k).count++;
    else if (kind === 'deduct' && k) {
      const parentId = assignment.get(m.id);
      const parent = parentId ? byId.get(parentId) : undefined;
      if (parent && categoryKey(parent) === k) continue;
      kc(k).area++;
      const ppm = calibrations[m.page]?.pixelsPerMeter;
      if (typeof ppm === 'number' && Number.isFinite(ppm) && ppm > 0) {
        ownOpenings.set(k, (ownOpenings.get(k) ?? 0) + polygonAreaM2(m.points, ppm));
      }
    }
  }

  const lines: BoqLine[] = [];
  const uncalNames: string[] = [];
  for (const c of computeCategorySummaries(ms, calibrations, categories)) {
    const s: MeasurementSummary = c.summary;
    const breakdown: BoqBreakdown = {
      netM2: Math.max(0, s.netM2),
      openingsM2: ownOpenings.get(c.category) ?? 0,
      itemAreaM2: s.itemAreaM2,
      lengthM: s.lengthM,
      itemPerimeterM: s.itemPerimeterM,
      count: s.count,
    };
    if (s.uncalibrated > 0) uncalNames.push(c.name);
    if (isEmpty(breakdown)) continue; // nothing measurable (empty, or only on uncalibrated pages)
    const price = pricing.categories[c.category] ?? {};
    const unit = price.unit ?? autoUnit(kindCounts.get(c.category) ?? { area: 0, length: 0, count: 0 });
    const quantity = round2(quantityIn(unit, breakdown));
    const wastePct = finiteNonNeg(price.wastePct) ? price.wastePct : 0;
    const unitPrice = finiteNonNeg(price.price) ? price.price : 0;
    const labourPrice = finiteNonNeg(price.labour) ? price.labour : 0;
    const quantityWithWaste = round2(quantity * (1 + wastePct / 100));
    lines.push({
      category: c.category,
      name: c.name,
      color: categories.find((x) => x.id === c.category)?.color,
      unit,
      unitIsAuto: !price.unit,
      quantity,
      wastePct,
      quantityWithWaste,
      unitPrice,
      labourPrice,
      total: round2(quantityWithWaste * (unitPrice + labourPrice)),
      breakdown,
      uncalibrated: s.uncalibrated,
    });
  }

  const subtotal = round2(lines.reduce((n, l) => n + l.total, 0));
  const discountPct = Math.min(100, Math.max(0, settings.discountPct || 0));
  const vatPct = Math.max(0, settings.vatPct || 0);
  const discount = round2((subtotal * discountPct) / 100);
  const afterDiscount = round2(subtotal - discount);
  const vat = round2((afterDiscount * vatPct) / 100);
  const total = round2(afterDiscount + vat);

  const uncalibrated = computeDocumentSummary(ms, calibrations).uncalibrated;
  const unpriced = lines.filter((l) => l.quantity > 0 && l.unitPrice + l.labourPrice === 0).length;
  const warnings: string[] = [];
  if (uncalibrated > 0) {
    warnings.push(
      `${uncalibrated === 1 ? 'מדידה אחת' : `${uncalibrated} מדידות`} בדפים לא מכוילים לא נכללו בכמויות` +
        (uncalNames.length ? ` (${uncalNames.join(', ')})` : '') +
        ' — כייל את הדפים',
    );
  }
  if (unpriced > 0) warnings.push(`${unpriced === 1 ? 'שורה אחת' : `${unpriced} שורות`} ללא מחיר`);

  return {
    lines,
    subtotal,
    discountPct,
    discount,
    afterDiscount,
    vatPct,
    vat,
    total,
    currency: settings.currency || '₪',
    projectName: settings.projectName,
    client: settings.client,
    uncalibrated,
    unpriced,
    warnings,
  };
}

/** "1,234.50" */
export function formatMoneyNumber(v: number): string {
  return round2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "₪ 1,234.50" */
export function formatMoney(v: number, currency = '₪'): string {
  return `${currency} ${formatMoneyNumber(v)}`;
}

/** Display name for a category key (re-exported for UI convenience). */
export { categoryName };
