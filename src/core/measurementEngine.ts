/**
 * Pure measurement math. All geometry is in PDF page units (see types.ts).
 * `pixelsPerMeter` = page units per real-world meter.
 */
import type { AreaMeasurement, Calibration, Category, ItemDims, MarkupKind, MeasurementKind, Point } from './types';

const EPS = 1e-9;

/** 8 distinct, semi-saturated colors that read well on white drawings. */
export const MEASUREMENT_COLORS: string[] = [
  '#1f77b4', // blue
  '#d62728', // red
  '#2ca02c', // green
  '#ff7f0e', // orange
  '#9467bd', // purple
  '#17becf', // teal
  '#e377c2', // pink
  '#8c564b', // brown
];

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function computePixelsPerMeter(p1: Point, p2: Point, meters: number): number {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters <= 0) {
    throw new Error('אורך הייחוס חייב להיות מספר חיובי');
  }
  const d = distance(p1, p2);
  if (!Number.isFinite(d) || d < 1e-6) {
    throw new Error('נקודות הכיול חופפות — יש לבחור שתי נקודות שונות');
  }
  return d / meters;
}

export function lengthMeters(a: Point, b: Point, pixelsPerMeter: number): number {
  return distance(a, b) / pixelsPerMeter;
}

/** Signed shoelace sum (twice the signed area). */
function signedArea2(points: Point[]): number {
  let s = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

export function polygonAreaPx(points: Point[]): number {
  if (points.length < 3) return 0;
  return Math.abs(signedArea2(points)) / 2;
}

export function polygonAreaM2(points: Point[], pixelsPerMeter: number): number {
  return polygonAreaPx(points) / (pixelsPerMeter * pixelsPerMeter);
}

export function polygonPerimeterMeters(
  points: Point[],
  pixelsPerMeter: number,
  closed: boolean = true,
): number {
  const n = points.length;
  if (n < 2) return 0;
  let total = 0;
  for (let i = 0; i < n - 1; i++) total += distance(points[i], points[i + 1]);
  if (closed && n > 2) total += distance(points[n - 1], points[0]);
  return total / pixelsPerMeter;
}

export function centroid(points: Point[]): Point {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0 };
  const a2 = n >= 3 ? signedArea2(points) : 0;
  // Scale-relative degeneracy check.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bboxArea = (maxX - minX) * (maxY - minY);
  if (n < 3 || Math.abs(a2) <= 1e-12 * Math.max(1, bboxArea)) {
    let sx = 0, sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }
  // Translate to first vertex for numerical stability.
  const ox = points[0].x, oy = points[0].y;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const ax = points[i].x - ox, ay = points[i].y - oy;
    const b = points[(i + 1) % n];
    const bx = b.x - ox, by = b.y - oy;
    const cross = ax * by - bx * ay;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }
  return { x: ox + cx / (3 * a2), y: oy + cy / (3 * a2) };
}

/** Ray-casting (even-odd) point-in-polygon test. */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y) {
      const xCross = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Keep distance from anchor, snap direction to the nearest multiple of stepDeg. */
export function snapAngle(anchor: Point, p: Point, stepDeg: number = 45): Point {
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  const len = Math.hypot(dx, dy);
  if (len === 0 || !(stepDeg > 0)) return { x: p.x, y: p.y };
  const step = (stepDeg * Math.PI) / 180;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  let x = anchor.x + Math.cos(ang) * len;
  let y = anchor.y + Math.sin(ang) * len;
  // Clean up floating noise so ortho lines are exactly ortho.
  if (Math.abs(x - anchor.x) < 1e-9 * len) x = anchor.x;
  if (Math.abs(y - anchor.y) < 1e-9 * len) y = anchor.y;
  return { x, y };
}

export function nearestVertex(p: Point, points: Point[], maxDist: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = distance(p, points[i]);
    if (d <= maxDist && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function orient(a: Point, b: Point, c: Point): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(v) < EPS ? 0 : v > 0 ? 1 : -1;
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) - EPS <= p.x &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= p.y &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (d1 !== d2 && d3 !== d4) return true;
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/** True if any two non-adjacent edges of the closed polygon touch or cross. */
export function isSelfIntersecting(points: Point[]): boolean {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // skip adjacent edges (share a vertex)
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function formatNumber(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  const fixed = Math.abs(v).toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const neg = v < 0 && Number(fixed) !== 0 ? '-' : '';
  return neg + grouped + (frac ? '.' + frac : '');
}

export function formatArea(m2: number): string {
  return `${formatNumber(m2)} מ״ר`;
}

export function formatLength(m: number): string {
  return `${formatNumber(m)} מ׳`;
}

const UNIT_FACTORS: Array<[RegExp, number]> = [
  [/^(mm|מ["״]?מ|מילימטר)$/i, 0.001],
  [/^(cm|ס["״]?מ|סנטימטר|סנטימטרים)$/i, 0.01],
  [/^(m|מ|מ['׳]|מטר|מטרים)$/i, 1],
];

/** Parse a user-typed length into meters; null if invalid or not positive. */
export function parseLengthInput(s: string): number | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  const m = /^([0-9]+(?:[.,][0-9]+)?|[.,][0-9]+)\s*(.*)$/.exec(trimmed);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2].trim();
  if (unit === '') return value;
  for (const [re, factor] of UNIT_FACTORS) {
    if (re.test(unit)) return value * factor;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Measurement kinds, deductions, summaries
// ---------------------------------------------------------------------------

/** Every kind stored in the `measurements` array: takeoff kinds + markup / annotation kinds. */
export type AnyKind = MeasurementKind | MarkupKind;

export const MARKUP_KINDS: readonly MarkupKind[] = ['note', 'text', 'rect', 'ellipse', 'triangle', 'diamond', 'line', 'cloud', 'arrow', 'pen', 'highlight', 'link'];

/** True for annotation kinds (not takeoff quantities — excluded from every sum / CSV total). */
export function isMarkupKind(kind: unknown): kind is MarkupKind {
  return typeof kind === 'string' && (MARKUP_KINDS as readonly string[]).includes(kind);
}

/** True when the measurement is a markup / annotation (see {@link isMarkupKind}). */
export function isMarkup(m: { kind?: unknown }): boolean {
  return isMarkupKind(m.kind);
}

/**
 * Kind of a measurement; legacy measurements without `kind` (or with an
 * unknown kind) are areas. Returns markup kinds as-is.
 */
export function kindOf(m: { kind?: AnyKind | string | null }): AnyKind {
  if (m.kind === 'deduct' || m.kind === 'length' || m.kind === 'count') return m.kind;
  if (isMarkupKind(m.kind)) return m.kind;
  return 'area';
}

/** Takeoff measurements only (markup removed). */
export function takeoffOnly<T extends { kind?: unknown }>(measurements: T[]): T[] {
  return measurements.some((m) => isMarkupKind(m.kind)) ? measurements.filter((m) => !isMarkupKind(m.kind)) : measurements;
}

/** Fill / stroke color used for every deduction (opening). */
export const DEDUCT_COLOR = '#e11d48';

export const KIND_LABELS: Record<AnyKind, string> = {
  area: 'שטח',
  deduct: 'ניכוי',
  length: 'אורך',
  count: 'ספירה',
  note: 'הערה',
  text: 'טקסט',
  rect: 'מלבן',
  ellipse: 'אליפסה',
  triangle: 'משולש',
  diamond: 'מעוין',
  line: 'קו ישר',
  cloud: 'ענן',
  arrow: 'חץ',
  pen: 'שרטוט',
  highlight: 'מרקר',
  link: 'קישור',
};

/** Label prefix for auto-numbered measurements of each kind ("חזית 3", "פתח 1", "קו 2"). */
export const KIND_LABEL_PREFIX: Record<AnyKind, string> = {
  area: 'חזית',
  deduct: 'פתח',
  length: 'קו',
  count: 'פריט',
  note: 'הערה',
  text: 'טקסט',
  rect: 'מלבן',
  ellipse: 'אליפסה',
  triangle: 'משולש',
  diamond: 'מעוין',
  line: 'קו',
  cloud: 'ענן',
  arrow: 'חץ',
  pen: 'שרטוט',
  highlight: 'מרקר',
  link: 'קישור',
};

/** Minimum number of points a finished measurement of this kind needs. */
export function minPoints(kind: AnyKind): number {
  if (kind === 'count' || kind === 'note' || kind === 'text') return 1;
  return kind === 'area' || kind === 'deduct' ? 3 : 2;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** Default work categories for an aluminum contractor (ids are stable, names editable). */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'windows', name: 'חלונות', color: '#1f77b4' },
  { id: 'vitrines', name: 'ויטרינות', color: '#17becf' },
  { id: 'doors', name: 'דלתות', color: '#9467bd' },
  { id: 'curtain-wall', name: 'קיר מסך', color: '#2ca02c' },
  { id: 'cladding', name: 'חיפוי', color: '#ff7f0e' },
  { id: 'railings', name: 'מעקות', color: '#8c564b' },
  { id: 'pergolas', name: 'פרגולות', color: '#e377c2' },
];

export const UNCATEGORIZED_LABEL = 'ללא קטגוריה';

/** Category key of a measurement ('' = uncategorised; tolerant of missing/garbage values in old saves). */
export function categoryKey(m: { category?: unknown }): string {
  return typeof m.category === 'string' ? m.category : '';
}

/** Display name for a category key; unknown ids fall back to the raw key. */
export function categoryName(key: string, categories: Category[] | undefined): string {
  if (!key) return UNCATEGORIZED_LABEL;
  return categories?.find((c) => c.id === key)?.name ?? key;
}

/** Sanitise a persisted category list; returns null when unusable. */
export function sanitizeCategories(v: unknown): Category[] | null {
  if (!Array.isArray(v)) return null;
  const out: Category[] = [];
  const seen = new Set<string>();
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const { id, name, color } = c as Record<string, unknown>;
    if (typeof id !== 'string' || !id || seen.has(id) || typeof name !== 'string') continue;
    seen.add(id);
    out.push({ id, name, color: typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : '#64748b' });
  }
  return out;
}

/** Next free number for an auto label of the given kind. */
export function nextLabelNumber(measurements: AreaMeasurement[], kind: AnyKind): number {
  const re = new RegExp(`^\\s*${KIND_LABEL_PREFIX[kind]}\\s*(\\d+)`);
  let max = 0;
  let count = 0;
  for (const m of measurements) {
    if (kindOf(m) !== kind) continue;
    count++;
    const r = re.exec(m.label);
    if (r) max = Math.max(max, parseInt(r[1], 10));
  }
  return Math.max(max, count) + 1;
}

/** Total length of an open polyline, in meters. */
export function polylineLengthMeters(points: Point[], pixelsPerMeter: number): number {
  return polygonPerimeterMeters(points, pixelsPerMeter, false);
}

/** Shortest distance (page units) from p to an open polyline. */
export function distanceToPolyline(p: Point, points: Point[]): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return distance(p, points[0]);
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/** Point halfway along an open polyline (by length) — used for label placement. */
export function polylineMidpoint(points: Point[]): Point {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1) return { ...points[0] };
  let total = 0;
  for (let i = 0; i < n - 1; i++) total += distance(points[i], points[i + 1]);
  let half = total / 2;
  for (let i = 0; i < n - 1; i++) {
    const seg = distance(points[i], points[i + 1]);
    if (half <= seg && seg > 0) {
      const t = half / seg;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    half -= seg;
  }
  return { ...points[n - 1] };
}

// ---------------------------------------------------------------------------
// Item dimensions (count groups)
// ---------------------------------------------------------------------------

const posNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Valid item dimensions of a count group (null for other kinds, missing or
 * garbage values). Width / height in meters.
 */
export function itemOf(m: { kind?: unknown; item?: unknown }): ItemDims | null {
  if (m.kind !== 'count' || !m.item || typeof m.item !== 'object') return null;
  const { width, height, code } = m.item as Record<string, unknown>;
  if (!posNum(width) || !posNum(height)) return null;
  const c = typeof code === 'string' ? code.trim() : '';
  return c ? { width, height, code: c } : { width, height };
}

/** Derived quantities of a count group with item dimensions: n×w×h (m²) and n×2(w+h) (m). */
export function itemQuantities(m: AreaMeasurement): { areaM2: number; n: number } | null {
  const it = itemOf(m);
  if (!it) return null;
  const n = m.points.length;
  return { areaM2: n * it.width * it.height, n };
}

/** "W1 150×140" (centimetres, as on a window schedule); '' without dimensions. */
export function formatItemDims(it: ItemDims | null, withCode = true): string {
  if (!it) return '';
  const cm = (v: number) => String(Math.round(v * 1000) / 10);
  const dims = `${cm(it.width)}×${cm(it.height)}`;
  return withCode && it.code ? `${it.code} ${dims}` : dims;
}

function ppmOf(calibrations: Record<number, Calibration>, page: number): number | null {
  const ppm = calibrations[page]?.pixelsPerMeter;
  return typeof ppm === 'number' && Number.isFinite(ppm) && ppm > 0 ? ppm : null;
}

/**
 * Map every deduction id → id of the area it belongs to (or null when its
 * centroid lies inside no area on the same page). When areas are nested, the
 * smallest containing area wins.
 */
export function assignDeductions(measurements: AreaMeasurement[]): Map<string, string | null> {
  const areasByPage = new Map<number, { id: string; points: Point[]; px: number }[]>();
  for (const m of measurements) {
    if (kindOf(m) !== 'area' || m.points.length < 3) continue;
    let list = areasByPage.get(m.page);
    if (!list) areasByPage.set(m.page, (list = []));
    list.push({ id: m.id, points: m.points, px: polygonAreaPx(m.points) });
  }
  const out = new Map<string, string | null>();
  for (const m of measurements) {
    if (kindOf(m) !== 'deduct') continue;
    const c = centroid(m.points);
    let best: { id: string; px: number } | null = null;
    for (const a of areasByPage.get(m.page) ?? []) {
      if ((!best || a.px < best.px) && pointInPolygon(c, a.points)) best = a;
    }
    out.set(m.id, best ? best.id : null);
  }
  return out;
}

export interface AreaNet {
  grossM2: number;
  deductM2: number;
  netM2: number;
  deductIds: string[];
}

/** Gross / deducted / net area of every area measurement on a calibrated page. */
export function computeNetAreas(
  measurements: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
  assignment: Map<string, string | null> = assignDeductions(measurements),
): Map<string, AreaNet> {
  const out = new Map<string, AreaNet>();
  for (const m of measurements) {
    if (kindOf(m) !== 'area') continue;
    const ppm = ppmOf(calibrations, m.page);
    if (ppm === null) continue;
    const g = polygonAreaM2(m.points, ppm);
    out.set(m.id, { grossM2: g, deductM2: 0, netM2: g, deductIds: [] });
  }
  for (const m of measurements) {
    const parent = assignment.get(m.id);
    if (!parent) continue;
    const net = out.get(parent);
    const ppm = ppmOf(calibrations, m.page);
    if (!net || ppm === null) continue;
    const d = polygonAreaM2(m.points, ppm);
    net.deductM2 += d;
    net.netM2 -= d;
    net.deductIds.push(m.id);
  }
  return out;
}

export interface MeasurementSummary {
  /** Sum of area polygons (calibrated pages only). */
  grossM2: number;
  /** Sum of deductions that belong to an area (positive number). */
  deductM2: number;
  /** grossM2 − deductM2 */
  netM2: number;
  /** Sum of length polylines (calibrated pages only). */
  lengthM: number;
  /** Measurements on uncalibrated pages (excluded from every sum). */
  uncalibrated: number;
  /** Deductions whose centroid lies in no area (excluded from deductM2). */
  orphanDeducts: number;
  /** Total number of counted items (markers of 'count' measurements; needs no calibration). */
  count: number;
  /** Area of the opening (deduct) polygons themselves, incl. orphans (calibrated pages only). */
  openingsM2: number;
  /** Count groups with item dimensions: Σ n×w×h (m²; needs no calibration). */
  itemAreaM2: number;
  /** Count groups with item dimensions: Σ n×2(w+h) — frame / profile length (m). */
}

const emptySummary = (): MeasurementSummary => ({
  grossM2: 0,
  deductM2: 0,
  netM2: 0,
  lengthM: 0,
  uncalibrated: 0,
  orphanDeducts: 0,
  count: 0,
  openingsM2: 0,
  itemAreaM2: 0,
});

/**
 * Totals over the measurements accepted by `inGroup`. A deduction is
 * subtracted from the group of the area it belongs to (so group nets add up
 * to the document net); its own polygon area counts in `openingsM2` of its
 * own group. `all` must contain every measurement deductions may belong to.
 */
function summarize(
  all: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
  inGroup: (m: AreaMeasurement) => boolean = () => true,
  assignment: Map<string, string | null> = assignDeductions(all),
): MeasurementSummary {
  const byId = new Map(all.map((m) => [m.id, m]));
  const s = emptySummary();
  for (const m of all) {
    const kind = kindOf(m);
    if (isMarkupKind(kind)) continue;
    const mine = inGroup(m);
    if (kind === 'count') {
      if (mine) {
        s.count += m.points.length;
        const iq = itemQuantities(m);
        if (iq) {
          s.itemAreaM2 += iq.areaM2;
        }
      }
      continue;
    }
    const ppm = ppmOf(calibrations, m.page);
    if (ppm === null) {
      if (mine) s.uncalibrated++;
      continue;
    }
    if (kind === 'area') {
      if (mine) s.grossM2 += polygonAreaM2(m.points, ppm);
    } else if (kind === 'length') {
      if (mine) s.lengthM += polylineLengthMeters(m.points, ppm);
    } else {
      const a = polygonAreaM2(m.points, ppm);
      if (mine) s.openingsM2 += a;
      const parentId = assignment.get(m.id);
      const parent = parentId ? byId.get(parentId) : undefined;
      if (parent) {
        if (inGroup(parent)) s.deductM2 += a;
      } else if (mine) s.orphanDeducts++;
    }
  }
  s.netM2 = s.grossM2 - s.deductM2;
  return s;
}

export interface CategorySummary {
  /** Category key ('' = uncategorised). */
  category: string;
  /** Display name (UNCATEGORIZED_LABEL for ''). */
  name: string;
  summary: MeasurementSummary;
}

/**
 * Per-category breakdown. Order follows `categories`, then unknown keys, then
 * uncategorised last. Only categories that have measurements are listed.
 */
export function computeCategorySummaries(
  measurements: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
  categories: Category[] = [],
): CategorySummary[] {
  const present = new Set(takeoffOnly(measurements).map(categoryKey));
  const keys = [
    ...categories.map((c) => c.id).filter((id) => present.has(id)),
    ...[...present].filter((k) => k && !categories.some((c) => c.id === k)),
    ...(present.has('') ? [''] : []),
  ];
  const assignment = assignDeductions(measurements);
  return keys.map((k) => ({
    category: k,
    name: categoryName(k, categories),
    summary: summarize(measurements, calibrations, (m) => categoryKey(m) === k, assignment),
  }));
}

/** Totals for one page. */
export function computePageSummary(
  measurements: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
  page: number,
): MeasurementSummary {
  return summarize(
    measurements.filter((m) => m.page === page),
    calibrations,
  );
}

/** Totals for the whole document. */
export function computeDocumentSummary(
  measurements: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
): MeasurementSummary {
  return summarize(measurements, calibrations);
}

/** Column headers of {@link buildMeasurementRows} (CSV / TSV / Excel "מדידות" sheet). */
export const MEASUREMENT_COLUMNS = [
  'מס׳',
  'סוג',
  'שם',
  'קטגוריה',
  'עמוד',
  'שטח (מ״ר)',
  'היקף (מ׳)',
  'אורך (מ׳)',
  'כמות',
  'מספר נקודות',
  'שייך ל',
  'מידות פריט (ס״מ)',
  'שטח פריטים (מ״ר)',
  'פרטים',
] as const;

/** Valid detail lines of a measurement (non-empty key or value), trimmed. */
export function detailsOf(m: { details?: unknown }): { k: string; v: string }[] {
  if (!Array.isArray(m.details)) return [];
  return m.details
    .filter((d): d is { k: unknown; v: unknown } => !!d && typeof d === 'object')
    .map((d) => ({ k: typeof d.k === 'string' ? d.k.trim() : '', v: typeof d.v === 'string' ? d.v.trim() : '' }))
    .filter((d) => d.k || d.v);
}

/** "זכוכית: 6.6.2; צבע: RAL 7016" */
export function formatDetails(m: { details?: unknown }): string {
  return detailsOf(m)
    .map((d) => (d.k && d.v ? `${d.k}: ${d.v}` : d.k || d.v))
    .join('; ');
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Table rows shared by the CSV / TSV exports: header row, one row per
 * measurement, per-category subtotal rows (only when some measurement has a
 * category), then document totals rows. Deduction rows carry a negative area;
 * length rows fill only the length column; count rows only the quantity
 * column (count groups with item dimensions also fill the item columns:
 * dimensions, n×w×h, n×2(w+h)). Category subtotals show the *net* area of the category's facades
 * (openings are subtracted from the category of the area they sit in), its
 * length and its count. Totals rows at the end: gross, deductions (negative),
 * net, total length, total count (+ item area / profile length when any
 * count group has item dimensions). Deductions outside every area are listed
 * but not counted in the totals (their "belongs to" cell is empty).
 *
 * `categories` resolves category ids to names (defaults to DEFAULT_CATEGORIES).
 */
export function buildMeasurementRows(
  all: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
  categories: Category[] = DEFAULT_CATEGORIES,
): string[][] {
  const measurements = takeoffOnly(all);
  const rows: (string | number)[][] = [
    [...MEASUREMENT_COLUMNS],
  ];
  const assignment = assignDeductions(measurements);
  const byId = new Map(measurements.map((m) => [m.id, m]));
  measurements.forEach((m, i) => {
    const kind = kindOf(m);
    const ppm = ppmOf(calibrations, m.page);
    let area = '';
    let perim = '';
    let len = '';
    let qty = '';
    let dims = '';
    let itemArea = '';
    if (kind === 'count') {
      qty = String(m.points.length);
      const iq = itemQuantities(m);
      if (iq) {
        dims = formatItemDims(itemOf(m));
        itemArea = iq.areaM2.toFixed(2);
      }
    } else if (ppm !== null) {
      if (kind === 'length') len = polylineLengthMeters(m.points, ppm).toFixed(2);
      else {
        const a = polygonAreaM2(m.points, ppm);
        area = (kind === 'deduct' ? -a : a).toFixed(2);
        perim = polygonPerimeterMeters(m.points, ppm).toFixed(2);
      }
    }
    const key = categoryKey(m);
    const cat = key ? categoryName(key, categories) : '';
    const parentId = assignment.get(m.id);
    const parent = parentId ? (byId.get(parentId)?.label ?? '') : '';
    rows.push([i + 1, KIND_LABELS[kind], m.label, cat, m.page, area, perim, len, qty, m.points.length, parent, dims, itemArea, formatDetails(m)]);
  });
  const anyItems = measurements.some((m) => itemOf(m));
  const itemCells = (t: MeasurementSummary): string[] =>
    anyItems ? ['', t.itemAreaM2.toFixed(2), ''] : ['', '', ''];
  if (measurements.some((m) => categoryKey(m))) {
    for (const c of computeCategorySummaries(measurements, calibrations, categories)) {
      const t = c.summary;
      rows.push(['', '', `סה״כ ${c.name}`, c.name, '', t.netM2.toFixed(2), '', t.lengthM.toFixed(2), t.count, '', '', ...itemCells(t)]);
    }
  }
  const s = computeDocumentSummary(measurements, calibrations);
  const total = (label: string, col: number, v: string | number) => {
    const r: (string | number)[] = ['', '', label, '', '', '', '', '', '', '', '', '', '', ''];
    r[col] = v;
    rows.push(r);
    return r;
  };
  total('ברוטו', 5, s.grossM2.toFixed(2));
  total('ניכויים', 5, (s.deductM2 === 0 ? 0 : -s.deductM2).toFixed(2));
  total('נטו', 5, s.netM2.toFixed(2));
  total('סה״כ אורך', 7, s.lengthM.toFixed(2));
  const countRow = total('סה״כ כמות', 8, s.count);
  if (anyItems) countRow.splice(11, 3, ...itemCells(s));
  // Notes / text labels (not quantities) in their own section after the totals.
  const notes = all.filter((m) => (m.kind === 'note' || m.kind === 'text') && (m.text ?? '').trim());
  if (notes.length) {
    rows.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    rows.push(['', 'הערות', 'שם', 'קטגוריה', 'עמוד', 'טקסט', '', '', '', '', '', '', '', '']);
    notes.forEach((m, i) => {
      const key = categoryKey(m);
      const text = (m.text ?? '').trim().replace(/\s*\r?\n\s*/g, ' / ');
      rows.push([i + 1, KIND_LABELS[kindOf(m)], m.label, key ? categoryName(key, categories) : '', m.page, text, '', '', '', '', '', '', '', '']);
    });
  }
  return rows.map((r) => r.map(String));
}

/** CSV (UTF-8 BOM, CRLF, RFC-4180 quoting) of {@link buildMeasurementRows}. */
export function measurementsToCSV(
  measurements: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
  categories?: Category[],
): string {
  const rows = buildMeasurementRows(measurements, calibrations, categories);
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function tsvCell(v: string): string {
  return v.replace(/[\t\r\n]+/g, ' ');
}

/**
 * TSV for the clipboard (paste into Excel / Google Sheets): tab-separated,
 * CRLF, no BOM, no quoting — tabs/newlines inside cells become spaces.
 */
export function measurementsToTSV(
  measurements: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
  categories?: Category[],
): string {
  const rows = buildMeasurementRows(measurements, calibrations, categories);
  return rows.map((r) => r.map(tsvCell).join('\t')).join('\r\n') + '\r\n';
}

let idCounter = 0;
export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  idCounter = (idCounter + 1) % 1e9;
  return `m_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Text inside each marker circle of a count group: the item number only — its schedule code
 * (e.g. "W1") when set, otherwise the number at the end of its label ("פריט 3" → "3"), otherwise
 * the label itself. Quantities (×n) are shown in the summaries, not on the drawing.
 */
export function countBadge(m: { label: string; item?: { code?: unknown } }): string {
  const code = typeof m.item?.code === 'string' ? m.item.code.trim() : '';
  if (code) return code;
  const n = /(\d+)\s*$/.exec(m.label)?.[1];
  return n ?? (m.label.trim() || '•');
}

/** Font size factor so a badge fits its circle (1 = up to two characters). */
export function badgeFontScale(text: string): number {
  const n = [...text].length;
  return n <= 2 ? 1 : n === 3 ? 0.78 : n === 4 ? 0.62 : 0.52;
}
