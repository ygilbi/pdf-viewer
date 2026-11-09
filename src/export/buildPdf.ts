/**
 * Builds ONE export PDF with pdf-lib: the selected original pages copied as
 * vectors (`copyPages`, never rasterised), the takeoff / markup overlay drawn
 * on top in the page's own coordinate system, then optional summary pages.
 *
 * Pure (no DOM): runs in the export Web Worker, on the main thread as a
 * fallback, and in vitest.
 */
import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  setLineJoin,
  LineJoinStyle,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { AreaMeasurement, Category, Point } from '../core/types';
import {
  DEDUCT_COLOR,
  centroid,
  computeNetAreas,
  assignDeductions,
  formatArea,
  formatLength,
  isMarkupKind,
  kindOf,
  categoryKey,
  categoryName,
  polygonAreaM2,
  polylineLengthMeters,
  polylineMidpoint,
  badgeFontScale,
  countBadge,
} from '../core/measurementEngine';
import {
  DEFAULT_STROKE_WIDTH,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_OPACITY,
  NOTE_PIN,
  arrowHeadPath,
  arrowHeadSize,
  arrowShaftEnd,
  cloudPath,
  linkHeadCenter,
  linkHeadRadius,
  dashedPolylinePath,
  linkLeader,
  markupBounds,
  roundedRectOutline,
  shapePath,
  notePinPath,
  polylinePath,
  rectOfPoints,
  rectPath,
  textLineBaselines,
} from '../core/markupGeometry';
import { hatchSegments } from './hatch';
import { pageGeometry, placement, viewportSize, viewportToPdf, type PageGeometry } from './pageTransform';
import { BLACK, WHITE, hexColor, shape, svgNum as f, type FontPair } from './pdfCommon';
import { writeBoq, writeItems, writeSummary } from './pdfSummary';
import { buildItemTable } from '../core/itemTable';
import type { PdfBuildInput, ProgressFn } from './types';

export class ExportCancelled extends Error {
  constructor() {
    super('הייצוא בוטל');
    this.name = 'AbortError';
  }
}

const CAL_COLOR = '#059669';

/** Overlay drawing context for one output page (all coordinates = app viewport space). */
interface Ctx {
  page: PDFPage;
  g: PageGeometry;
  pl: ReturnType<typeof placement>;
  /** app page units → viewport units of this PDF page (1 unless sizes disagree). */
  sx: number;
  sy: number;
  /** Visual scale of strokes / labels for this page size. */
  s: number;
  fonts: FontPair;
}

const P = (c: Ctx, p: Point): Point => ({ x: p.x * c.sx, y: p.y * c.sy });

function path(
  c: Ctx,
  d: string,
  o: { fill?: RGB; stroke?: RGB; width?: number; opacity?: number; strokeOpacity?: number; dash?: number[]; round?: boolean; multiply?: boolean },
) {
  if (!d) return;
  if (o.round) c.page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round));
  c.page.drawSvgPath(d, {
    x: c.pl.tx,
    y: c.pl.ty,
    rotate: degrees(c.pl.rotate),
    color: o.fill,
    borderColor: o.stroke,
    borderWidth: o.stroke ? (o.width ?? 1) : undefined,
    opacity: o.opacity,
    borderOpacity: o.strokeOpacity,
    borderDashArray: o.dash,
    borderLineCap: o.round ? LineCapStyle.Round : undefined,
    blendMode: o.multiply ? BlendMode.Multiply : undefined,
  });
  if (o.round) c.page.pushOperators(popGraphicsState());
}

function polyD(pts: Point[], closed: boolean): string {
  if (!pts.length) return '';
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += `L${f(pts[i].x)} ${f(pts[i].y)}`;
  return closed ? d + 'Z' : d;
}

function circleD(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r;
  return (
    `M${f(cx + r)} ${f(cy)}` +
    `C${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)}` +
    `C${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)}` +
    `C${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)}` +
    `C${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)}Z`
  );
}

/** Draw a single line of text; (x, baseline) in viewport space; align relative to x. */
function text(
  c: Ctx,
  str: string,
  x: number,
  baseline: number,
  size: number,
  o: { bold?: boolean; color?: RGB; align?: 'left' | 'center' | 'right' } = {},
): number {
  const font = o.bold ? c.fonts.bold : c.fonts.regular;
  const { visual, width, parts } = shape(font, str, size);
  if (!visual.trim()) return width;
  const x0 = o.align === 'center' ? x - width / 2 : o.align === 'right' ? x - width : x;
  // Single-script pieces (see `shape`), advanced along the baseline in viewport space.
  for (const p of parts) {
    if (!p.text.trim()) continue;
    const at = viewportToPdf(c.g, { x: x0 + p.dx, y: baseline });
    c.page.drawText(p.text, { x: at.x, y: at.y, size, font, color: o.color ?? BLACK, rotate: degrees(c.pl.rotate) });
  }
  return width;
}

/** Boxed multi-line label centred on `at` (viewport space). */
function label(c: Ctx, lines: { t: string; bold?: boolean }[], at: Point, color: RGB) {
  const fs = 8 * c.s;
  const lh = fs * 1.25;
  const pad = 2.5 * c.s;
  const widths = lines.map((l) => shape(l.bold ? c.fonts.bold : c.fonts.regular, l.t, fs).width);
  const w = Math.max(...widths) + pad * 2;
  const h = lines.length * lh + pad * 1.2;
  const x = at.x - w / 2;
  const y = at.y - h / 2;
  path(c, rectPath({ x, y, width: w, height: h }), { fill: WHITE, opacity: 0.85, stroke: color, width: 0.6 * c.s });
  lines.forEach((l, i) => text(c, l.t, at.x, y + pad * 0.6 + lh * i + fs * 0.95, fs, { bold: l.bold, align: 'center' }));
}

const isTakeoff = (m: AreaMeasurement) => !isMarkupKind(m.kind);

function drawTakeoff(c: Ctx, ms: AreaMeasurement[], ppm: number | null, nets: ReturnType<typeof computeNetAreas>) {
  const s = c.s;
  const labels: (() => void)[] = [];
  const order = ['area', 'deduct', 'length', 'count'];
  const sorted = [...ms].sort((a, b) => order.indexOf(kindOf(a)) - order.indexOf(kindOf(b)));
  for (const m of sorted) {
    const kind = kindOf(m);
    const pts = m.points.map((p) => P(c, p));
    const col = hexColor(kind === 'deduct' ? DEDUCT_COLOR : m.color);
    if (kind === 'area' && pts.length >= 3) {
      path(c, polyD(pts, true), { fill: col, opacity: 0.22, stroke: col, width: 1.4 * s, round: true });
      const net = nets.get(m.id);
      const area = net ? (net.deductM2 > 0 ? `נטו ${formatArea(net.netM2)}` : formatArea(net.grossM2)) : 'לא מכויל';
      labels.push(() => label(c, [{ t: m.label, bold: true }, { t: area }], centroid(pts), col));
    } else if (kind === 'deduct' && pts.length >= 3) {
      path(c, polyD(pts, true), { fill: col, opacity: 0.16 });
      const segs = hatchSegments(pts, 5 * s);
      if (segs.length) {
        const d = segs.map(([a, b]) => `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`).join('');
        path(c, d, { stroke: col, width: 0.5 * s, strokeOpacity: 0.8 });
      }
      path(c, polyD(pts, true), { stroke: col, width: 1.1 * s, round: true });
      const a = ppm ? `-${formatArea(polygonAreaM2(m.points, ppm))}` : 'לא מכויל';
      labels.push(() => label(c, [{ t: m.label, bold: true }, { t: a }], centroid(pts), col));
    } else if (kind === 'length' && pts.length >= 2) {
      path(c, polyD(pts, false), { stroke: col, width: 1.6 * s, round: true });
      for (const [p, q] of [
        [pts[0], pts[1]],
        [pts[pts.length - 1], pts[pts.length - 2]],
      ]) {
        const dx = q.x - p.x, dy = q.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * 4 * s, ny = (dx / len) * 4 * s;
        path(c, `M${f(p.x - nx)} ${f(p.y - ny)}L${f(p.x + nx)} ${f(p.y + ny)}`, { stroke: col, width: 1.4 * s, round: true });
      }
      const l = ppm ? formatLength(polylineLengthMeters(m.points, ppm)) : 'לא מכויל';
      const mid = polylineMidpoint(pts);
      labels.push(() => label(c, [{ t: `${m.label}: ${l}`, bold: false }], { x: mid.x, y: mid.y - 9 * s }, col));
    } else if (kind === 'count' && pts.length >= 1) {
      const r = 5.5 * s;
      // Item number only in each circle; quantities are in the summary page.
      const badge = countBadge(m);
      const fs = r * 1.15 * badgeFontScale(badge);
      pts.forEach((p) => {
        path(c, circleD(p.x, p.y, r), { fill: col, stroke: WHITE, width: 0.8 * s });
        text(c, badge, p.x, p.y + fs * 0.36, fs, { bold: true, color: WHITE, align: 'center' });
      });
    }
  }
  return labels;
}

function drawCalibration(c: Ctx, cal: { p1: Point; p2: Point; meters: number }) {
  const s = c.s;
  const col = hexColor(CAL_COLOR);
  const a = P(c, cal.p1), b = P(c, cal.p2);
  path(c, `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`, { stroke: col, width: 1.3 * s, dash: [6 * s, 3 * s] });
  for (const p of [a, b]) path(c, circleD(p.x, p.y, 2.4 * s), { fill: col });
  return () =>
    label(c, [{ t: `כיול: ${formatLength(cal.meters)}`, bold: true }], { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 9 * c.s }, col);
}

/** A /Link annotation over the link area that jumps to output page `target` (fit page). */
function addLinkAnnotation(out: PDFDocument, c: Ctx, m: AreaMeasurement, target: number | undefined, outPages: PDFPage[]) {
  if (target === undefined || m.points.length < 2) return;
  // Clickable: the bubble and the callout head.
  const scaled = { ...m, points: m.points.map((p) => P(c, p)), fontSize: linkHeadRadius(m) * c.sx };
  const r = markupBounds(scaled);
  const a = viewportToPdf(c.g, { x: r.x, y: r.y });
  const b = viewportToPdf(c.g, { x: r.x + r.width, y: r.y + r.height });
  const annot = out.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)],
    Border: [0, 0, 0],
    Dest: [outPages[target].ref, 'Fit'],
  });
  c.page.node.addAnnot(out.context.register(annot));
}

function drawMarkup(c: Ctx, m: AreaMeasurement, noteNo: number | undefined) {
  const kind = m.kind;
  const pts = m.points.map((p) => P(c, p));
  if (!pts.length) return;
  const sw = m.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  const col = hexColor(m.color, '#dc2626');
  switch (kind) {
    case 'rect':
      path(c, rectPath(rectOfPoints(pts)), { stroke: col, width: sw });
      break;
    case 'cloud':
      path(c, cloudPath(rectOfPoints(pts)), { stroke: col, width: sw, round: true });
      break;
    case 'ellipse':
    case 'triangle':
    case 'diamond':
      path(c, shapePath(kind, rectOfPoints(pts)), { stroke: col, width: sw, round: true });
      break;
    case 'line':
      if (pts.length >= 2) path(c, polylinePath([pts[0], pts[pts.length - 1]]), { stroke: col, width: sw, round: true });
      break;
    case 'highlight':
      path(c, rectPath(rectOfPoints(pts)), { fill: hexColor(m.color, HIGHLIGHT_COLOR), opacity: HIGHLIGHT_OPACITY, multiply: true });
      break;
    case 'link': {
      // Callout: dashed rounded bubble → leader → split head (name / page) + reference label.
      if (pts.length < 2) break;
      const r = rectOfPoints(pts);
      const hr = linkHeadRadius(m) * c.sx;
      const head = linkHeadCenter(pts, hr);
      const lc = m.targetPage ? col : hexColor('#d97706');
      path(c, dashedPolylinePath(roundedRectOutline(r), hr * 0.42, hr * 0.28), { stroke: lc, width: 1.6 * c.s, round: true });
      const leader = linkLeader(r, head, hr);
      if (leader) path(c, `M${f(leader[0].x)} ${f(leader[0].y)}L${f(leader[1].x)} ${f(leader[1].y)}`, { stroke: lc, width: 0.9 * c.s });
      path(c, circleD(head.x, head.y, hr), { fill: WHITE, stroke: lc, width: 1 * c.s });
      path(c, `M${f(head.x - hr)} ${f(head.y)}L${f(head.x + hr)} ${f(head.y)}`, { stroke: lc, width: 0.8 * c.s });
      const name = (m.text ?? '').trim() || '?';
      const nfs = hr * (name.length > 3 ? 0.55 : 0.72);
      text(c, name, head.x, head.y - hr * 0.2, nfs, { bold: true, color: hexColor('#111827'), align: 'center' });
      text(c, m.targetPage ? `עמ׳ ${m.targetPage}` : 'ללא יעד', head.x, head.y + hr * 0.58, hr * 0.46, { color: hexColor('#334155'), align: 'center' });
      const ref = (m.refLabel ?? '').trim();
      if (ref) {
        const right = head.x >= r.x + r.width / 2;
        text(c, ref, head.x + (right ? hr * 1.25 : -hr * 1.25), head.y - hr * 0.35, hr * 0.62, { bold: true, color: hexColor('#111827'), align: right ? 'left' : 'right' });
      }
      break;
    }
    case 'pen':
      path(c, polylinePath(pts), { stroke: col, width: sw, round: true });
      break;
    case 'arrow': {
      if (pts.length < 2) break;
      const [tail, head] = pts;
      const size = arrowHeadSize(sw);
      const end = arrowShaftEnd(tail, head, size);
      path(c, `M${f(tail.x)} ${f(tail.y)}L${f(end.x)} ${f(end.y)}`, { stroke: col, width: sw, round: true });
      path(c, arrowHeadPath(tail, head, size), { fill: col });
      break;
    }
    case 'text': {
      const fs = (m.fontSize ?? 12) * c.sy;
      for (const l of textLineBaselines(pts[0], m.text, fs)) text(c, l.text, l.x, l.y, fs, { color: col, align: 'right' });
      break;
    }
    case 'note': {
      const ps = c.s;
      path(c, notePinPath(pts[0], ps), { fill: col, stroke: WHITE, width: 1 * ps });
      if (noteNo !== undefined) {
        const fs = NOTE_PIN.radius * ps * (noteNo > 99 ? 0.9 : 1.15);
        text(c, String(noteNo), pts[0].x, pts[0].y - NOTE_PIN.headY * ps + fs * 0.36, fs, { bold: true, color: WHITE, align: 'center' });
      }
      break;
    }
  }
}

function drawLegend(c: Ctx, ms: AreaMeasurement[], categories: Category[]) {
  const keys: string[] = [];
  let hasDeduct = false;
  for (const m of ms) {
    if (kindOf(m) === 'deduct') hasDeduct = true;
    else if (!keys.includes(categoryKey(m))) keys.push(categoryKey(m));
  }
  if (!keys.length && !hasDeduct) return;
  keys.sort((a, b) => {
    const ia = categories.findIndex((x) => x.id === a), ib = categories.findIndex((x) => x.id === b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || (a ? 0 : 1);
  });
  const entries = keys.map((k) => {
    const cat = categories.find((x) => x.id === k);
    // Uncategorised: colour of its first measurement.
    const color = cat?.color ?? ms.find((m) => categoryKey(m) === k && kindOf(m) !== 'deduct')?.color ?? '#64748b';
    return { name: categoryName(k, categories), color };
  });
  if (hasDeduct) entries.push({ name: 'ניכוי / פתח', color: DEDUCT_COLOR });
  const s = c.s;
  const fs = 8 * s, lh = fs * 1.6, pad = 5 * s, sw = 9 * s;
  const title = 'מקרא';
  const w =
    Math.max(shape(c.fonts.bold, title, fs).width, ...entries.map((e) => shape(c.fonts.regular, e.name, fs).width + sw + 4 * s)) +
    pad * 2;
  const h = pad * 2 + lh * (entries.length + 1);
  const x = 12 * s, y = 12 * s;
  path(c, rectPath({ x, y, width: w, height: h }), { fill: WHITE, opacity: 0.92, stroke: BLACK, width: 0.5 * s });
  const right = x + w - pad;
  text(c, title, right, y + pad + fs, fs, { bold: true, align: 'right' });
  entries.forEach((e, i) => {
    const top = y + pad + lh * (i + 1);
    const col = hexColor(e.color);
    path(c, rectPath({ x: right - sw, y: top + (lh - sw) / 2 - 1 * s, width: sw, height: sw }), { fill: col, opacity: 0.5, stroke: col, width: 0.6 * s });
    text(c, e.name, right - sw - 4 * s, top + fs, fs, { align: 'right' });
  });
}

/** Note numbers (1..n) in output page order — shared by the pins and the summary list. */
export function numberNotes(input: Pick<PdfBuildInput, 'pages' | 'measurements'>): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const p of input.pages) {
    for (const m of input.measurements) if (m.page === p.globalPage && m.kind === 'note') out.set(m.id, ++n);
  }
  return out;
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

export async function buildExportPdf(
  input: PdfBuildInput,
  onProgress: ProgressFn = () => {},
  isCancelled: () => boolean = () => false,
): Promise<Uint8Array> {
  const check = () => {
    if (isCancelled()) throw new ExportCancelled();
  };
  const { options: o, pages } = input;
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  out.setTitle(input.title);
  out.setCreator('PDF Takeoff Viewer');
  out.setProducer('pdf-lib');
  const fonts: FontPair = {
    regular: await out.embedFont(input.fonts.regular, { subset: true }),
    bold: await out.embedFont(input.fonts.bold, { subset: true }),
  };

  const pageSet = new Set(pages.map((p) => p.globalPage));
  const selected = input.measurements.filter((m) => pageSet.has(m.page));
  const nets = computeNetAreas(selected.filter(isTakeoff), input.calibrations, assignDeductions(selected.filter(isTakeoff)));
  const notes = numberNotes({ pages, measurements: selected });

  // 1) Load sources + copy pages, batched per consecutive run of the same doc
  //    (one copier per batch → shared resources are copied once).
  const outPages: PDFPage[] = [];
  if (o.drawings) {
    const docIds = [...new Set(pages.map((p) => p.docId))];
    const sources = new Map<string, PDFDocument>();
    for (let i = 0; i < docIds.length; i++) {
      check();
      onProgress('load', i, docIds.length);
      const bytes = input.bytes[docIds[i]];
      if (!bytes) throw new Error(`חסר תוכן הקובץ ${docIds[i]}`);
      sources.set(docIds[i], await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }));
      await yieldNow();
    }
    onProgress('load', docIds.length, docIds.length);
    for (let i = 0; i < pages.length; ) {
      let j = i;
      while (j < pages.length && pages[j].docId === pages[i].docId && j - i < 8) j++;
      check();
      const src = sources.get(pages[i].docId)!;
      const copied = await out.copyPages(
        src,
        pages.slice(i, j).map((p) => p.localPage - 1),
      );
      for (const cp of copied) outPages.push(out.addPage(cp));
      i = j;
      onProgress('pages', i * 0.5, pages.length);
      await yieldNow();
    }
  } else {
    for (const p of pages) {
      const sz = input.pageSizes[p.globalPage] ?? { width: 595.28, height: 841.89 };
      outPages.push(out.addPage([sz.width, sz.height]));
    }
  }

  const pageIndex = new Map(pages.map((p, i) => [p.globalPage, i]));
  // 2) Overlay per page.
  for (let i = 0; i < pages.length; i++) {
    check();
    const spec = pages[i];
    const page = outPages[i];
    const g = o.drawings ? pageGeometry(page.getMediaBox(), page.getCropBox(), page.getRotation().angle) : pageGeometry(page.getMediaBox(), null, 0);
    const vs = viewportSize(g);
    const app = input.pageSizes[spec.globalPage] ?? vs;
    const c: Ctx = {
      page,
      g,
      pl: placement(g),
      sx: app.width > 0 ? vs.width / app.width : 1,
      sy: app.height > 0 ? vs.height / app.height : 1,
      s: Math.min(8, Math.max(0.7, Math.max(vs.width, vs.height) / 1190)),
      fonts,
    };
    const ms = selected.filter((m) => m.page === spec.globalPage);
    const takeoff = ms.filter(isTakeoff);
    const cal = input.calibrations[spec.globalPage];
    const ppm = cal && cal.pixelsPerMeter > 0 ? cal.pixelsPerMeter : null;
    const labels: (() => void)[] = [];
    if (o.measurements) labels.push(...drawTakeoff(c, takeoff, ppm, nets));
    if (o.calibration && cal) labels.push(drawCalibration(c, cal));
    if (o.markup) for (const m of ms) if (isMarkupKind(m.kind)) drawMarkup(c, m, notes.get(m.id));
    // Link areas become real PDF links when their target page is part of this export.
    if (o.markup) for (const m of ms) if (m.kind === 'link') addLinkAnnotation(out, c, m, pageIndex.get(m.targetPage ?? -1), outPages);
    for (const l of labels) l();
    if (o.legend && o.measurements) drawLegend(c, takeoff, input.categories);
    onProgress('pages', pages.length * 0.5 + (i + 1) * 0.5, pages.length);
    if (i % 4 === 3) await yieldNow();
  }

  // 3) Items table, then the generic summary / BOQ pages.
  if (o.items) {
    check();
    onProgress('summary', 0, 1);
    writeItems(out, fonts, input, buildItemTable(selected, input.calibrations, input.categories));
    if (!o.summary) onProgress('summary', 1, 1);
  }
  if (o.summary) {
    check();
    onProgress('summary', 0, 1);
    writeSummary(out, fonts, input, selected, notes);
    onProgress('summary', 1, 1);
  }
  if (o.boq && input.boq) {
    check();
    writeBoq(out, fonts, input, input.boq);
  }

  check();
  onProgress('save', 0, 1);
  const bytes = await out.save({ addDefaultPage: false, objectsPerTick: 200 });
  onProgress('save', 1, 1);
  return bytes;
}
