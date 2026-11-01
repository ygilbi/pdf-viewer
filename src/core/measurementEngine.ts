/**
 * Pure measurement math. All geometry is in PDF page units (see types.ts).
 * `pixelsPerMeter` = page units per real-world meter.
 */
import type { AreaMeasurement, Calibration, MeasurementKind, Point } from './types';

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

/** Kind of a measurement; legacy measurements without `kind` are areas. */
export function kindOf(m: { kind?: MeasurementKind | string | null }): MeasurementKind {
  return m.kind === 'deduct' || m.kind === 'length' ? m.kind : 'area';
}

/** Fill / stroke color used for every deduction (opening). */
export const DEDUCT_COLOR = '#e11d48';

export const KIND_LABELS: Record<MeasurementKind, string> = {
  area: 'שטח',
  deduct: 'ניכוי',
  length: 'אורך',
};

/** Label prefix for auto-numbered measurements of each kind ("חזית 3", "פתח 1", "קו 2"). */
export const KIND_LABEL_PREFIX: Record<MeasurementKind, string> = {
  area: 'חזית',
  deduct: 'פתח',
  length: 'קו',
};

/** Minimum number of points a finished measurement of this kind needs. */
export function minPoints(kind: MeasurementKind): number {
  return kind === 'length' ? 2 : 3;
}

/** Next free number for an auto label of the given kind. */
export function nextLabelNumber(measurements: AreaMeasurement[], kind: MeasurementKind): number {
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
}

function summarize(
  measurements: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
): MeasurementSummary {
  const assignment = assignDeductions(measurements);
  const s: MeasurementSummary = { grossM2: 0, deductM2: 0, netM2: 0, lengthM: 0, uncalibrated: 0, orphanDeducts: 0 };
  for (const m of measurements) {
    const ppm = ppmOf(calibrations, m.page);
    if (ppm === null) {
      s.uncalibrated++;
      continue;
    }
    const kind = kindOf(m);
    if (kind === 'area') s.grossM2 += polygonAreaM2(m.points, ppm);
    else if (kind === 'length') s.lengthM += polylineLengthMeters(m.points, ppm);
    else if (assignment.get(m.id)) s.deductM2 += polygonAreaM2(m.points, ppm);
    else s.orphanDeducts++;
  }
  s.netM2 = s.grossM2 - s.deductM2;
  return s;
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

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV (UTF-8 BOM, CRLF). Deduction rows carry a negative area; length rows
 * fill only the length column. Totals rows at the end: gross, deductions
 * (negative), net, total length. Deductions outside every area are listed
 * but not counted in the totals (their "belongs to" cell is empty).
 */
export function measurementsToCSV(
  measurements: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
): string {
  const rows: (string | number)[][] = [
    ['מס׳', 'סוג', 'שם', 'עמוד', 'שטח (מ״ר)', 'היקף (מ׳)', 'אורך (מ׳)', 'מספר נקודות', 'שייך ל'],
  ];
  const assignment = assignDeductions(measurements);
  const byId = new Map(measurements.map((m) => [m.id, m]));
  measurements.forEach((m, i) => {
    const kind = kindOf(m);
    const ppm = ppmOf(calibrations, m.page);
    let area = '';
    let perim = '';
    let len = '';
    if (ppm !== null) {
      if (kind === 'length') len = polylineLengthMeters(m.points, ppm).toFixed(2);
      else {
        const a = polygonAreaM2(m.points, ppm);
        area = (kind === 'deduct' ? -a : a).toFixed(2);
        perim = polygonPerimeterMeters(m.points, ppm).toFixed(2);
      }
    }
    const parentId = assignment.get(m.id);
    const parent = parentId ? (byId.get(parentId)?.label ?? '') : '';
    rows.push([i + 1, KIND_LABELS[kind], m.label, m.page, area, perim, len, m.points.length, parent]);
  });
  const s = computeDocumentSummary(measurements, calibrations);
  rows.push(['', '', 'ברוטו', '', s.grossM2.toFixed(2), '', '', '', '']);
  rows.push(['', '', 'ניכויים', '', (s.deductM2 === 0 ? 0 : -s.deductM2).toFixed(2), '', '', '', '']);
  rows.push(['', '', 'נטו', '', s.netM2.toFixed(2), '', '', '', '']);
  rows.push(['', '', 'סה״כ אורך', '', '', '', s.lengthM.toFixed(2), '', '']);
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

let idCounter = 0;
export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  idCounter = (idCounter + 1) % 1e9;
  return `m_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
