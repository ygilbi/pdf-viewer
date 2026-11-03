/**
 * Excel (.xlsx) export: "כתב כמויות" (BOQ with live formulas), "מדידות" (every
 * measurement row, like the CSV) and "הערות". exceljs is loaded lazily — this
 * module itself is only reached through a dynamic import from runExport.
 *
 * BOQ formulas (row r): G = ROUND(E*(1+F),2)  J = ROUND(G*(H+I),2); then
 * subtotal = SUM(J), discount = -ROUND(sub*pct,2), VAT = ROUND(after*pct,2),
 * total = after + VAT — the same arithmetic as pricing/boq.ts, so the cached
 * results written with each formula equal what Excel recalculates.
 */
import type { Workbook, Worksheet, Cell } from 'exceljs';
import { UNIT_LABELS, describeQuantity, type Boq } from './boq';

export interface XlsxInput {
  boq: Boq;
  /** buildMeasurementRows output (header first; numbers as strings). */
  measurementRows: string[][];
  /** Notes / text markup: [no, kind, label, category, page, text]. */
  notes: string[][];
  title: string;
  dateText: string;
  files: string[];
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } } as const;
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } } as const;
const THIN = { style: 'thin', color: { argb: 'FFCBD5E1' } } as const;
const BORDER = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const NUM = '#,##0.00';
const PCT = '0.0%';

const moneyFormat = (currency: string) => `"${currency.replace(/"/g, '')}" #,##0.00;-"${currency.replace(/"/g, '')}" #,##0.00`;

/** First BOQ table row (1-based) — header is the row above. */
export const BOQ_FIRST_ROW = 8;

async function loadExcel(): Promise<typeof import('exceljs')> {
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs') } & typeof import('exceljs');
  return mod.default ?? mod;
}

function boqSheet(wb: Workbook, input: XlsxInput) {
  const { boq } = input;
  const ws = wb.addWorksheet('כתב כמויות', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: BOQ_FIRST_ROW - 1 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = [
    { width: 6 }, // A מס׳
    { width: 22 }, // B קטגוריה
    { width: 34 }, // C פירוט
    { width: 8 }, // D יחידה
    { width: 12 }, // E כמות
    { width: 9 }, // F פחת
    { width: 14 }, // G כמות כולל פחת
    { width: 14 }, // H מחיר ליח׳
    { width: 14 }, // I עבודה ליח׳
    { width: 18 }, // J סה״כ
  ];
  const money = moneyFormat(boq.currency);

  ws.mergeCells('A1:J1');
  const t = ws.getCell('A1');
  t.value = 'כתב כמויות ומחירים';
  t.font = { bold: true, size: 16 };
  t.alignment = { horizontal: 'right' };
  const meta: [string, string][] = [
    ['פרויקט:', boq.projectName || input.title],
    ['לקוח:', boq.client],
    ['תאריך:', input.dateText],
    [input.files.length > 1 ? 'קבצים:' : 'קובץ:', input.files.join(', ')],
  ];
  meta.forEach(([k, v], i) => {
    const r = ws.getRow(2 + i);
    r.getCell(1).value = k;
    r.getCell(1).font = { bold: true };
    ws.mergeCells(2 + i, 2, 2 + i, 6);
    r.getCell(2).value = v;
  });

  const head = ws.getRow(BOQ_FIRST_ROW - 1);
  head.values = ['מס׳', 'קטגוריה', 'פירוט', 'יחידה', 'כמות', 'פחת', 'כמות כולל פחת', 'מחיר ליח׳', 'עבודה ליח׳', 'סה״כ'];
  head.font = { bold: true };
  head.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.border = BORDER;
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  head.height = 30;

  const first = BOQ_FIRST_ROW;
  boq.lines.forEach((l, i) => {
    const r = first + i;
    const row = ws.getRow(r);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = l.name;
    row.getCell(3).value = describeQuantity(l.unit, l.breakdown);
    row.getCell(4).value = UNIT_LABELS[l.unit];
    row.getCell(5).value = l.quantity;
    row.getCell(6).value = l.wastePct / 100;
    row.getCell(7).value = { formula: `ROUND(E${r}*(1+F${r}),2)`, result: l.quantityWithWaste };
    row.getCell(8).value = l.unitPrice;
    row.getCell(9).value = l.labourPrice;
    row.getCell(10).value = { formula: `ROUND(G${r}*(H${r}+I${r}),2)`, result: l.total };
    row.getCell(5).numFmt = NUM;
    row.getCell(6).numFmt = PCT;
    row.getCell(7).numFmt = NUM;
    for (const c of [8, 9, 10]) row.getCell(c).numFmt = money;
    for (let c = 1; c <= 10; c++) row.getCell(c).border = BORDER;
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(4).alignment = { horizontal: 'center' };
  });
  const last = first + boq.lines.length - 1;

  // Totals block
  let r = first + boq.lines.length;
  const totalRow = (label: string, value: Cell['value'], o: { pct?: number; bold?: boolean } = {}) => {
    const row = ws.getRow(r);
    row.getCell(8).value = label;
    row.getCell(8).font = { bold: true };
    row.getCell(8).alignment = { horizontal: 'right' };
    if (o.pct !== undefined) {
      row.getCell(9).value = o.pct;
      row.getCell(9).numFmt = PCT;
    }
    const v = row.getCell(10);
    v.value = value;
    v.numFmt = money;
    v.font = { bold: true, size: o.bold ? 12 : 11 };
    v.border = BORDER;
    if (o.bold) for (const c of [8, 9, 10]) row.getCell(c).fill = TOTAL_FILL;
    return r++;
  };
  const sub = totalRow('סה״כ לפני הנחה', boq.lines.length ? { formula: `SUM(J${first}:J${last})`, result: boq.subtotal } : 0);
  const disc = totalRow('הנחה', { formula: `-ROUND(J${sub}*I${r},2)`, result: boq.discount ? -boq.discount : 0 }, { pct: boq.discountPct / 100 });
  const after = totalRow('סה״כ אחרי הנחה', { formula: `J${sub}+J${disc}`, result: boq.afterDiscount });
  const vat = totalRow('מע״מ', { formula: `ROUND(J${after}*I${r},2)`, result: boq.vat }, { pct: boq.vatPct / 100 });
  totalRow('סה״כ לתשלום', { formula: `J${after}+J${vat}`, result: boq.total }, { bold: true });

  if (boq.warnings.length) {
    r++;
    for (const w of boq.warnings) {
      ws.mergeCells(r, 1, r, 10);
      const c = ws.getCell(r, 1);
      c.value = `⚠ ${w}`;
      c.font = { color: { argb: 'FFB45309' } };
      r++;
    }
  }
  ws.pageSetup.printTitlesRow = `${BOQ_FIRST_ROW - 1}:${BOQ_FIRST_ROW - 1}`;
  return ws;
}

const numeric = /^-?\d+(\.\d+)?$/;

function tableSheet(wb: Workbook, name: string, rows: string[][], widths: number[], numericFrom = 0): Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = widths.map((width) => ({ width }));
  rows.forEach((cells, i) => {
    const row = ws.getRow(i + 1);
    cells.forEach((v, k) => {
      const c = row.getCell(k + 1);
      if (i > 0 && k >= numericFrom && numeric.test(v)) {
        c.value = Number(v);
        if (v.includes('.')) c.numFmt = NUM;
      } else c.value = v;
    });
    // Totals / subtotal rows of the measurement table have an empty "no." cell and a label.
    if (i === 0 || (!cells[0] && cells[2])) row.font = { bold: true };
  });
  ws.getRow(1).eachCell((c) => {
    c.fill = HEADER_FILL;
    c.border = BORDER;
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  return ws;
}

export async function buildXlsx(input: XlsxInput): Promise<Uint8Array> {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PDF Viewer — תמחור';
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;
  boqSheet(wb, input);
  tableSheet(wb, 'מדידות', input.measurementRows, [6, 9, 22, 14, 7, 12, 11, 11, 8, 10, 16, 16, 14, 14]);
  const notes = input.notes.length ? [['מס׳', 'סוג', 'שם', 'קטגוריה', 'דף', 'טקסט'], ...input.notes] : [['הערות'], ['אין הערות בדפים שנבחרו']];
  const ns = tableSheet(wb, 'הערות', notes, [6, 9, 18, 14, 6, 70], 99);
  ns.getColumn(6).alignment = { wrapText: true, vertical: 'top' };
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
