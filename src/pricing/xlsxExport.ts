/**
 * Excel (.xlsx) export: "טבלת פריטים" (the owner's items table, first sheet), "כתב כמויות" (BOQ with live formulas), "מדידות" (every
 * measurement row, like the CSV) and "הערות". exceljs is loaded lazily — this
 * module itself is only reached through a dynamic import from runExport.
 *
 * BOQ formulas (row r): G = ROUND(E*(1+F),2)  J = ROUND(G*(H+I),2); then
 * subtotal = SUM(J), discount = -ROUND(sub*pct,2), VAT = ROUND(after*pct,2),
 * total = after + VAT — the same arithmetic as pricing/boq.ts, so the cached
 * results written with each formula equal what Excel recalculates.
 */
import type { Workbook, Worksheet, Cell, Fill } from 'exceljs';
import { UNIT_LABELS, describeQuantity, type Boq } from './boq';
import { ITEM_COLUMNS, type ItemSubtotal, type ItemTable, type ItemUnit } from '../core/itemTable';

export interface XlsxInput {
  /** טבלת פריטים for the selected pages (sheet omitted when absent). */
  items?: ItemTable;
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
    ws.mergeCells(2 + i, 1, 2 + i, 2);
    r.getCell(1).value = k;
    r.getCell(1).font = { bold: true };
    r.getCell(1).alignment = { horizontal: 'right' };
    ws.mergeCells(2 + i, 3, 2 + i, 6);
    r.getCell(3).value = v;
    r.getCell(3).alignment = { horizontal: 'right' };
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

/** Header row of the items sheet (title + meta above it). */
export const ITEMS_HEADER_ROW = 4;
const SUBTOTAL_FILL: Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6EEF8' } };
const UNIT_FIELD: Record<ItemUnit, keyof ItemSubtotal> = { 'יח׳': 'units', 'מ״ר': 'm2', 'מ׳': 'm' };
const UNITS: ItemUnit[] = ['יח׳', 'מ״ר', 'מ׳'];

/**
 * טבלת פריטים: A שם פריט · B קטגוריה · C מערכת · D גודל · E כמות (number) · F יחידה · G מידע נוסף.
 * Quantity is a real number (with its unit next to it) unless the user typed free text that is
 * not a plain number. Each category ends with one subtotal row per unit it uses —
 * SUMIF(F,unit,E) over the category's rows, so edits in Excel recalculate — and the grand total
 * rows add up the subtotals.
 */
function itemsSheet(wb: Workbook, input: XlsxInput, table: ItemTable) {
  const ws = wb.addWorksheet('טבלת פריטים', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: ITEMS_HEADER_ROW }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = [{ width: 26 }, { width: 16 }, { width: 22 }, { width: 14 }, { width: 11 }, { width: 7 }, { width: 40 }];
  ws.mergeCells('A1:G1');
  const t = ws.getCell('A1');
  t.value = 'טבלת פריטים';
  t.font = { bold: true, size: 16 };
  t.alignment = { horizontal: 'right' };
  ws.mergeCells('A2:G2');
  const meta = ws.getCell('A2');
  meta.value = [input.title, input.files.join(', '), input.dateText && `תאריך: ${input.dateText}`].filter(Boolean).join(' · ');
  meta.font = { color: { argb: 'FF64748B' } };
  meta.alignment = { horizontal: 'right' };

  const head = ws.getRow(ITEMS_HEADER_ROW);
  const [cName, cCat, cSys, cSize, cQty, cExtra] = ITEM_COLUMNS;
  head.values = [cName, cCat, cSys, cSize, cQty, 'יחידה', cExtra];
  head.font = { bold: true };
  head.height = 22;
  head.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.border = BORDER;
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });

  let r = ITEMS_HEADER_ROW + 1;
  const style = (row: ReturnType<Worksheet['getRow']>, fill?: Fill) => {
    for (let c = 1; c <= 7; c++) {
      const cell = row.getCell(c);
      cell.border = BORDER;
      cell.alignment = { vertical: 'middle', wrapText: true, horizontal: c === 5 || c === 6 ? 'center' : 'right' };
      if (fill) cell.fill = fill;
    }
  };
  const fmtQty = (v: number) => (Number.isInteger(v) ? '#,##0' : NUM);
  /** Subtotal cells per unit, for the grand total. */
  const subCells: Record<ItemUnit, string[]> = { 'יח׳': [], 'מ״ר': [], 'מ׳': [] };

  if (!table.groups.length) {
    ws.mergeCells(r, 1, r, 7);
    ws.getCell(r, 1).value = 'אין פריטים בדפים שנבחרו (פריט = ספירה, או שטח / אורך שסומן כפריט)';
    return ws;
  }
  for (const g of table.groups) {
    const first = r;
    const textQty = new Set<ItemUnit>(); // units with a quantity Excel cannot add up (text cell)
    for (const it of g.rows) {
      const row = ws.getRow(r);
      row.getCell(1).value = it.name || null;
      row.getCell(2).value = it.categoryName || null;
      row.getCell(3).value = it.system || null;
      row.getCell(4).value = it.size || null;
      // A typed quantity stays text unless it is just a number (optionally with its unit).
      const plain = !it.custom.qty || !it.qtyText.replace(/-?\d[\d,]*(?:[.,]\d+)?/, '').replace(/יח['׳]|מ["״]ר|מ['׳]|מטר|\s/g, '');
      if (it.qty !== null && !plain) textQty.add(it.unit);
      if (it.qty !== null && plain) {
        row.getCell(5).value = it.qty;
        row.getCell(5).numFmt = it.kind === 'count' && Number.isInteger(it.qty) ? '#,##0' : NUM;
      } else row.getCell(5).value = it.qtyText;
      row.getCell(6).value = it.unit;
      row.getCell(7).value = it.extra || null;
      style(row);
      r++;
    }
    const last = r - 1;
    const used = UNITS.filter((u) => g.rows.some((x) => x.unit === u && x.qty !== null));
    for (const u of used.length ? used : [null]) {
      const row = ws.getRow(r);
      row.getCell(1).value = `סה״כ ${g.name}`;
      if (u) {
        const v = g.subtotal[UNIT_FIELD[u]];
        row.getCell(5).value = textQty.has(u) ? v : { formula: `SUMIF(F${first}:F${last},"${u.replace(/"/g, '""')}",E${first}:E${last})`, result: v };
        row.getCell(5).numFmt = u === 'יח׳' ? fmtQty(v) : NUM;
        row.getCell(6).value = u;
        subCells[u].push(`E${r}`);
      } else row.getCell(5).value = '—';
      row.font = { bold: true };
      style(row, SUBTOTAL_FILL);
      r++;
    }
  }
  if (table.groups.length > 1) {
    const used = UNITS.filter((u) => subCells[u].length);
    for (const u of used.length ? used : [null]) {
      const row = ws.getRow(r);
      row.getCell(1).value = 'סה״כ כללי';
      if (u) {
        const v = table.total[UNIT_FIELD[u]];
        row.getCell(5).value = { formula: subCells[u].join('+'), result: v };
        row.getCell(5).numFmt = u === 'יח׳' ? fmtQty(v) : NUM;
        row.getCell(6).value = u;
      } else row.getCell(5).value = '—';
      row.font = { bold: true, size: 12 };
      style(row, TOTAL_FILL);
      r++;
    }
  }
  if (table.uncalibrated) {
    r++;
    ws.mergeCells(r, 1, r, 7);
    const c = ws.getCell(r, 1);
    c.value = `⚠ ${table.uncalibrated} שורות בדף לא מכויל — הכמות שלהן אינה נכללת בסיכומים`;
    c.font = { color: { argb: 'FFB45309' } };
  }
  ws.pageSetup.printTitlesRow = `${ITEMS_HEADER_ROW}:${ITEMS_HEADER_ROW}`;
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
  if (input.items) itemsSheet(wb, input, input.items);
  boqSheet(wb, input);
  tableSheet(wb, 'מדידות', input.measurementRows, [6, 9, 22, 14, 7, 12, 11, 11, 8, 10, 16, 16, 14, 14]);
  const notes = input.notes.length ? [['מס׳', 'סוג', 'שם', 'קטגוריה', 'דף', 'טקסט'], ...input.notes] : [['הערות'], ['אין הערות בדפים שנבחרו']];
  const ns = tableSheet(wb, 'הערות', notes, [6, 9, 18, 14, 6, 70], 99);
  ns.getColumn(6).alignment = { wrapText: true, vertical: 'top' };
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
