/** Summary table pages (A4 portrait, Hebrew RTL) appended to the export PDF. */
import type { PDFDocument, PDFPage, RGB } from 'pdf-lib';
import { rgb } from 'pdf-lib';
import type { AreaMeasurement } from '../core/types';
import {
  DEDUCT_COLOR,
  computeCategorySummaries,
  computeDocumentSummary,
  computePageSummary,
  isMarkupKind,
  type MeasurementSummary,
} from '../core/measurementEngine';
import { BLACK, GREY, drawShaped, ellipsize, hexColor, shape, wrapCell, wrapText, type FontPair } from './pdfCommon';
import { ITEM_COLUMNS, formatSubtotal, type ItemTable } from '../core/itemTable';
import type { PdfBuildInput } from './types';

const W = 595.28;
const H = 841.89;
const M = 40;
const HEAD_BG = rgb(0.89, 0.91, 0.94);
const ZEBRA = rgb(0.965, 0.972, 0.98);
const SUBTOTAL_BG = rgb(0.9, 0.94, 0.99);
const WHITE_BG = rgb(1, 1, 1);
const GRAND_BG = rgb(0.8, 0.87, 0.96);
const LINE = rgb(0.8, 0.82, 0.86);

interface Col {
  title: string;
  width: number;
  align?: 'right' | 'center';
  /** Centred column whose cells may wrap (default: one line, ellipsis). */
  wrap?: boolean;
  /** Cells without Hebrew letters read left to right ("120×150", not "150×120"). */
  ltr?: boolean;
}

interface Cell {
  t: string;
  bold?: boolean;
  swatch?: string;
  color?: RGB;
}

class Writer {
  page!: PDFPage;
  y = 0; // distance from the top
  pageNo = 0;
  constructor(
    private doc: PDFDocument,
    readonly fonts: FontPair,
    private heading: string,
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pageNo++;
    this.y = M;
    this.text(this.heading, W - M, this.y + 10, 10, { bold: true, color: GREY });
    this.page.drawLine({ start: { x: M, y: H - this.y - 15 }, end: { x: W - M, y: H - this.y - 15 }, thickness: 0.5, color: LINE });
    this.y += 28;
  }

  ensure(h: number) {
    if (this.y + h > H - M) this.newPage();
  }

  /** x = anchor (right edge for 'right'), yTop = baseline measured from the top. */
  text(str: string, x: number, baselineFromTop: number, size: number, o: { bold?: boolean; color?: RGB; align?: 'right' | 'center' | 'left'; rtl?: boolean } = {}) {
    const font = o.bold ? this.fonts.bold : this.fonts.regular;
    const sh = shape(font, str, size, o.rtl);
    const width = sh.width;
    if (!sh.visual.trim()) return width;
    const align = o.align ?? 'right';
    const x0 = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    drawShaped(this.page, sh, x0, H - baselineFromTop, { size, font, color: o.color ?? BLACK });
    return width;
  }

  title(str: string, size = 13) {
    this.ensure(size * 2.4);
    this.y += size * 0.6;
    this.text(str, W - M, this.y + size, size, { bold: true });
    this.y += size * 1.7;
  }

  para(str: string, size = 9, color: RGB = BLACK) {
    for (const line of wrapText(this.fonts.regular, str, size, W - 2 * M)) {
      this.ensure(size * 1.5);
      this.text(line, W - M, this.y + size, size, { color, rtl: true });
      this.y += size * 1.45;
    }
  }

  /**
   * RTL table: first column at the right. Repeats the header on page breaks. Text cells wrap
   * (at most `maxLines` lines, then an ellipsis); centred cells stay on one line (ellipsis).
   * `fill(i)` overrides the zebra background of row i; `keepWithNext(i)` moves row i to the next
   * page together with row i + 1 when that one would not fit (a group's last row + its subtotal).
   */
  table(
    cols: Col[],
    rows: Cell[][],
    o: { totalRow?: boolean; fill?: (i: number) => RGB | undefined; maxLines?: number; keepWithNext?: (i: number) => boolean } = {},
  ) {
    const fs = 8.5;
    const pad = 4;
    const lineH = fs * 1.35;
    const header = () => {
      this.ensure(2 * (lineH + 2 * pad));
      this.row(cols, cols.map((c) => ({ t: c.title, bold: true })), [[]], HEAD_BG, fs, pad, lineH);
    };
    const wrappedRows = rows.map((r) =>
      r.map((cell, k) => {
        const font = cell.bold ? this.fonts.bold : this.fonts.regular;
        const width = cols[k].width - 2 * pad - (cell.swatch ? 12 : 0);
        return cols[k].align === 'center' && !cols[k].wrap ? [ellipsize(font, cell.t, fs, width)] : wrapCell(font, cell.t, fs, width, o.maxLines);
      }),
    );
    const heights = wrappedRows.map((w) => Math.max(1, ...w.map((l) => l.length)) * lineH + 2 * pad);
    header();
    rows.forEach((r, i) => {
      let need = heights[i];
      for (let j = i; o.keepWithNext?.(j) && j + 1 < rows.length; j++) need += heights[j + 1];
      if (this.y + need > H - M) {
        this.newPage();
        header();
      }
      const isTotal = o.totalRow && i === rows.length - 1;
      const bg = o.fill?.(i) ?? (isTotal ? HEAD_BG : i % 2 ? ZEBRA : undefined);
      this.row(cols, r, wrappedRows[i], bg, fs, pad, lineH);
    });
    this.y += 10;
  }

  private row(cols: Col[], cells: Cell[], wrapped: string[][], bg: RGB | undefined, fs: number, pad: number, lineH: number) {
    const lines = Math.max(1, ...wrapped.map((w) => w.length || 1));
    const h = lines * lineH + 2 * pad;
    const total = cols.reduce((n, c) => n + c.width, 0);
    const left = W - M - total;
    if (bg) this.page.drawRectangle({ x: left, y: H - this.y - h, width: total, height: h, color: bg });
    this.page.drawLine({ start: { x: left, y: H - this.y - h }, end: { x: W - M, y: H - this.y - h }, thickness: 0.4, color: LINE });
    let right = W - M;
    cols.forEach((col, k) => {
      const cell = cells[k] ?? { t: '' };
      const textLines = wrapped[k]?.length ? wrapped[k] : [cell.t];
      let r = right - pad;
      if (cell.swatch) {
        const c = hexColor(cell.swatch);
        this.page.drawRectangle({ x: r - 8, y: H - this.y - pad - fs, width: 8, height: 8, color: c, opacity: 0.6, borderColor: c, borderWidth: 0.6 });
        r -= 12;
      }
      textLines.forEach((t, li) => {
        const base = this.y + pad + fs * 0.95 + li * lineH;
        const rtl = col.ltr && !/[\u0590-\u05ff]/.test(t) ? false : undefined;
        if (col.align === 'center') this.text(t, right - col.width / 2, base, fs, { bold: cell.bold, color: cell.color, align: 'center', rtl });
        else this.text(t, r, base, fs, { bold: cell.bold, color: cell.color, rtl: true });
      });
      right -= col.width;
    });
    this.y += h;
  }
}

const n2 = (v: number) => (v === 0 ? '0' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qtyCells = (s: MeasurementSummary): Cell[] => [
  { t: n2(s.grossM2) },
  { t: s.deductM2 ? `-${n2(s.deductM2)}` : '0' },
  { t: n2(s.netM2), bold: true },
  { t: n2(s.lengthM) },
  { t: String(s.count) },
];
const QTY_COLS: Col[] = [
  { title: 'ברוטו (מ״ר)', width: 62, align: 'center' },
  { title: 'ניכויים (מ״ר)', width: 62, align: 'center' },
  { title: 'נטו (מ״ר)', width: 62, align: 'center' },
  { title: 'אורך (מ׳)', width: 58, align: 'center' },
  { title: 'כמות', width: 44, align: 'center' },
];

export function writeSummary(
  doc: PDFDocument,
  fonts: FontPair,
  input: PdfBuildInput,
  selected: AreaMeasurement[],
  notes: Map<string, number>,
) {
  const w = new Writer(doc, fonts, `סיכום כמויות — ${input.title}`);
  const docName = new Map(input.docs.map((d) => [d.id, d.name]));
  const multiDoc = new Set(input.pages.map((p) => p.docId)).size > 1;

  w.title('סיכום כמויות', 16);
  const files = [...new Set(input.pages.map((p) => docName.get(p.docId) ?? p.docId))];
  w.para(`${files.length > 1 ? 'קבצים' : 'קובץ'}: ${files.join(', ')}`, 9, GREY);
  w.para(`דפים בייצוא: ${input.pages.length}${input.dateText ? ` · תאריך: ${input.dateText}` : ''}`, 9, GREY);
  w.y += 6;

  // Per page
  let anyUncal = false;
  const pageRows: Cell[][] = input.pages.map((p) => {
    const s = computePageSummary(selected, input.calibrations, p.globalPage);
    const uncal = s.uncalibrated > 0;
    anyUncal ||= uncal;
    const name = multiDoc ? `${docName.get(p.docId) ?? ''} · עמ׳ ${p.localPage}` : `עמוד ${p.globalPage}`;
    return [{ t: String(p.globalPage) }, { t: name + (uncal ? ' *' : '') }, ...qtyCells(s)];
  });
  const tot = computeDocumentSummary(selected, input.calibrations);
  pageRows.push([{ t: '' }, { t: 'סה״כ', bold: true }, ...qtyCells(tot).map((c) => ({ ...c, bold: true }))]);
  w.title('לפי עמוד');
  w.table([{ title: 'דף', width: 32, align: 'center' }, { title: 'עמוד / קובץ', width: 195 }, ...QTY_COLS], pageRows, { totalRow: true });

  // Per category
  const cats = computeCategorySummaries(selected, input.calibrations, input.categories);
  if (cats.length) {
    const catRows: Cell[][] = cats.map((c) => [
      { t: c.name, swatch: input.categories.find((x) => x.id === c.category)?.color ?? '#94a3b8' },
      ...qtyCells(c.summary),
    ]);
    catRows.push([{ t: 'סה״כ', bold: true }, ...qtyCells(tot).map((c) => ({ ...c, bold: true }))]);
    w.title('לפי קטגוריה');
    w.table([{ title: 'קטגוריה', width: 227 }, ...QTY_COLS], catRows, { totalRow: true });
  }
  if (anyUncal || tot.orphanDeducts > 0) {
    if (anyUncal) w.para('* בדפים המסומנים יש מדידות בדף לא מכויל — הן אינן נכללות בסיכומי השטח והאורך.', 8, GREY);
    if (tot.orphanDeducts > 0) w.para(`${tot.orphanDeducts} פתחים מחוץ לכל שטח — אינם מנוכים.`, 8, GREY);
    w.y += 6;
  }

  // Legend
  if (input.options.legend) {
    const used = new Set(selected.filter((m) => !isMarkupKind(m.kind)).map((m) => m.category ?? ''));
    const rows: Cell[][] = input.categories.filter((c) => used.has(c.id)).map((c) => [{ t: c.name, swatch: c.color }]);
    if (selected.some((m) => m.kind === 'deduct')) rows.push([{ t: 'ניכוי / פתח', swatch: DEDUCT_COLOR }]);
    if (rows.length) {
      w.title('מקרא');
      w.table([{ title: 'קטגוריה', width: 200 }], rows);
    }
  }

  // Notes
  if (input.options.markup && notes.size) {
    const list = selected
      .filter((m) => notes.has(m.id))
      .sort((a, b) => notes.get(a.id)! - notes.get(b.id)!)
      .map((m) => [
        { t: String(notes.get(m.id)), bold: true },
        { t: String(m.page) },
        { t: (m.text ?? '').trim() || m.label },
      ]);
    w.title('הערות');
    w.table(
      [
        { title: 'מס׳', width: 34, align: 'center' },
        { title: 'דף', width: 34, align: 'center' },
        { title: 'הערה', width: W - 2 * M - 68 },
      ],
      list,
    );
  }
}

/**
 * טבלת פריטים — the owner's items table on its own A4 page(s): columns (right to left) שם פריט ·
 * קטגוריה · מערכת · גודל · כמות · מידע נוסף; each category's rows followed by a bold, tinted
 * subtotal row; a grand total when there is more than one category.
 */
export function writeItems(doc: PDFDocument, fonts: FontPair, input: PdfBuildInput, table: ItemTable) {
  const w = new Writer(doc, fonts, `טבלת פריטים — ${input.title}`);
  const docName = new Map(input.docs.map((d) => [d.id, d.name]));
  w.title('טבלת פריטים', 16);
  const files = [...new Set(input.pages.map((p) => docName.get(p.docId) ?? p.docId))];
  w.para(`${files.length > 1 ? 'קבצים' : 'קובץ'}: ${files.join(', ')}`, 9, GREY);
  w.para(`דפים בייצוא: ${input.pages.length}${input.dateText ? ` · תאריך: ${input.dateText}` : ''}`, 9, GREY);
  w.y += 6;
  if (!table.groups.length) {
    w.para('אין פריטים בדפים שנבחרו. פריט הוא ספירה, או שטח / אורך שסומן כפריט.', 10);
    return;
  }

  const [cName, cCat, cSys, cSize, cQty, cExtra] = ITEM_COLUMNS;
  const cols: Col[] = [
    { title: cName, width: 112 },
    { title: cCat, width: 74 },
    { title: cSys, width: 86 },
    { title: cSize, width: 62, align: 'center', wrap: true, ltr: true },
    { title: cQty, width: 62, align: 'center', wrap: true, ltr: true },
    { title: cExtra, width: W - 2 * M - 396 },
  ];
  const rows: Cell[][] = [];
  const kind: ('row' | 'sub' | 'grand')[] = [];
  const lines = (t: string) => t.split(' · ').join('\n'); // one unit per line in total cells
  for (const g of table.groups) {
    const swatch = g.color ?? '#94a3b8';
    g.rows.forEach((r) => {
      rows.push([{ t: r.name }, { t: r.categoryName, swatch }, { t: r.system }, { t: r.size }, { t: r.qtyText }, { t: r.extra }]);
      kind.push('row');
    });
    rows.push([{ t: `סה״כ ${g.name}`, bold: true }, { t: '' }, { t: '' }, { t: '' }, { t: lines(formatSubtotal(g.subtotal)), bold: true }, { t: '' }]);
    kind.push('sub');
  }
  if (table.groups.length > 1) {
    rows.push([{ t: 'סה״כ כללי', bold: true }, { t: '' }, { t: '' }, { t: '' }, { t: lines(formatSubtotal(table.total)), bold: true }, { t: '' }]);
    kind.push('grand');
  }
  let zebra = 0;
  const fills = kind.map((k) => (k === 'sub' ? SUBTOTAL_BG : k === 'grand' ? GRAND_BG : zebra++ % 2 ? ZEBRA : WHITE_BG));
  w.table(cols, rows, {
    fill: (i) => fills[i],
    maxLines: 3,
    keepWithNext: (i) => i + 1 < kind.length && kind[i + 1] !== 'row',
  });
  if (table.uncalibrated) w.para(`* ${table.uncalibrated} שורות בדף לא מכויל — הכמות שלהן אינה נכללת בסיכומים.`, 8, GREY);
}
