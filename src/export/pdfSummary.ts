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
import { BLACK, GREY, hexColor, shape, wrapText, type FontPair } from './pdfCommon';
import type { PdfBuildInput } from './types';

const W = 595.28;
const H = 841.89;
const M = 40;
const HEAD_BG = rgb(0.89, 0.91, 0.94);
const ZEBRA = rgb(0.965, 0.972, 0.98);
const LINE = rgb(0.8, 0.82, 0.86);

interface Col {
  title: string;
  width: number;
  align?: 'right' | 'center';
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
    const { visual, width } = shape(font, str, size, o.rtl);
    if (!visual.trim()) return width;
    const align = o.align ?? 'right';
    const x0 = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    this.page.drawText(visual, { x: x0, y: H - baselineFromTop, size, font, color: o.color ?? BLACK });
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

  /** RTL table: first column at the right. Repeats the header on page breaks. */
  table(cols: Col[], rows: Cell[][], o: { totalRow?: boolean } = {}) {
    const fs = 8.5;
    const pad = 4;
    const lineH = fs * 1.35;
    const header = () => {
      this.ensure(lineH + 2 * pad + 16);
      this.row(cols, cols.map((c) => ({ t: c.title, bold: true })), [[]], HEAD_BG, fs, pad, lineH);
    };
    header();
    rows.forEach((r, i) => {
      // wrap text cells
      const wrapped = r.map((cell, k) =>
        cols[k].align === 'center' ? [cell.t] : wrapText(cell.bold ? this.fonts.bold : this.fonts.regular, cell.t, fs, cols[k].width - 2 * pad - (cell.swatch ? 12 : 0)),
      );
      const lines = Math.max(1, ...wrapped.map((w) => w.length));
      const h = lines * lineH + 2 * pad;
      if (this.y + h > H - M) {
        this.newPage();
        header();
      }
      const isTotal = o.totalRow && i === rows.length - 1;
      this.row(cols, r, wrapped, isTotal ? HEAD_BG : i % 2 ? ZEBRA : undefined, fs, pad, lineH);
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
        if (col.align === 'center') this.text(t, right - col.width / 2, base, fs, { bold: cell.bold, color: cell.color, align: 'center' });
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
