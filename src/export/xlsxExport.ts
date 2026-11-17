/**
 * Excel (.xlsx) export: "טבלת פריטים" (the owner's items table, first sheet), "מדידות" (every
 * measurement row, like the CSV) and "הערות". exceljs is loaded lazily — this
 * module itself is only reached through a dynamic import from runExport.
 */
import type { Workbook, Worksheet, Fill } from 'exceljs';
import { ITEM_COLUMNS, type ItemSubtotal, type ItemTable, type ItemUnit } from '../core/itemTable';

export interface XlsxInput {
  /** טבלת פריטים for the selected pages (sheet omitted when absent). */
  items?: ItemTable;
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

async function loadExcel(): Promise<typeof import('exceljs')> {
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs') } & typeof import('exceljs');
  return mod.default ?? mod;
}

/** Header row of the items sheet (title + meta above it). */
export const ITEMS_HEADER_ROW = 4;
const SUBTOTAL_FILL: Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6EEF8' } };
const UNIT_FIELD: Record<ItemUnit, keyof ItemSubtotal> = { 'יח׳': 'units', 'מ״ר': 'm2', 'מ׳': 'm' };
/** Columns of the items sheet (A…H). */
const COLS = 9;
/** טבלת פריטים column numbers (1-based) and letters (for formulas). */
const IC = { name: 1, cat: 2, sys: 3, w: 4, h: 5, m2: 6, qty: 7, unit: 8, extra: 9 } as const;
const L = (c: number) => String.fromCharCode(64 + c);
/** Drops float noise (1.5 × 1.4 × 2 = 4.199999…) from the cached results. */
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * טבלת פריטים: A שם פריט · B קטגוריה · C מערכת · D רוחב (ס״מ) · E גובה (ס״מ) · F מ״ר · G כמות (number) ·
 * H יחידה · I מידע נוסף.
 * Quantity is a real number (with its unit next to it) unless the user typed free text that is
 * not a plain number. Each category ends with one subtotal row per unit it uses —
 * SUMIF(F,unit,E) over the category's rows, so edits in Excel recalculate — and the grand total
 * rows add up the subtotals. Counted items with measured dims also add their area (n × w × h) to
 * the category's m² subtotal (as in buildItemTable): a constant added to the SUMIF, or a plain
 * value when the category has no m² rows.
 */
function itemsSheet(wb: Workbook, input: XlsxInput, table: ItemTable) {
  const ws = wb.addWorksheet('טבלת פריטים', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: ITEMS_HEADER_ROW }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = [{ width: 26 }, { width: 16 }, { width: 22 }, { width: 10 }, { width: 10 }, { width: 11 }, { width: 11 }, { width: 7 }, { width: 40 }];
  ws.mergeCells('A1:I1');
  const t = ws.getCell('A1');
  t.value = 'טבלת פריטים';
  t.font = { bold: true, size: 16 };
  t.alignment = { horizontal: 'right' };
  ws.mergeCells('A2:I2');
  const meta = ws.getCell('A2');
  meta.value = [input.title, input.files.join(', '), input.dateText && `תאריך: ${input.dateText}`].filter(Boolean).join(' · ');
  meta.font = { color: { argb: 'FF64748B' } };
  meta.alignment = { horizontal: 'right' };

  const head = ws.getRow(ITEMS_HEADER_ROW);
  const [cName, cCat, cSys, cW, cH, cM2, cQty, cExtra] = ITEM_COLUMNS;
  head.values = [cName, cCat, cSys, cW, cH, cM2, cQty, 'יחידה', cExtra];
  head.font = { bold: true };
  head.height = 22;
  head.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.border = BORDER;
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });

  let r = ITEMS_HEADER_ROW + 1;
  const style = (row: ReturnType<Worksheet['getRow']>, fill?: Fill) => {
    for (let c = 1; c <= COLS; c++) {
      const cell = row.getCell(c);
      cell.border = BORDER;
      cell.alignment = { vertical: 'middle', wrapText: true, horizontal: c >= IC.w && c <= IC.unit ? 'center' : 'right' };
      if (fill) cell.fill = fill;
    }
  };
  const fmtQty = (v: number) => (Number.isInteger(v) ? '#,##0' : NUM);
  /** Subtotal cells for the grand total: quantity per unit (יח׳ / מ׳) and the m² column. */
  const subCells: Record<'יח׳' | 'מ׳' | 'm2', string[]> = { 'יח׳': [], 'מ׳': [], m2: [] };

  if (!table.groups.length) {
    ws.mergeCells(r, 1, r, COLS);
    ws.getCell(r, 1).value = 'אין פריטים בדפים שנבחרו';
    return ws;
  }
  for (const g of table.groups) {
    const first = r;
    const textQty = new Set<ItemUnit>(); // units with a quantity Excel cannot add up (text cell)
    for (const it of g.rows) {
      const row = ws.getRow(r);
      row.getCell(IC.name).value = it.name || null;
      row.getCell(IC.cat).value = it.categoryName || null;
      row.getCell(IC.sys).value = it.system || null;
      // Width / height in cm: numbers when numeric, else the typed text.
      const dim = (meters: number | null, text: string, col: number) => {
        const c = row.getCell(col);
        if (/^\s*\d+(?:[.,]\d+)?\s*$/.test(text)) {
          c.value = Number(text.trim().replace(',', '.'));
          c.numFmt = '0.#';
        } else if (!text && meters != null) {
          c.value = Math.round(meters * 1000) / 10;
          c.numFmt = '0.#';
        } else c.value = text || null;
      };
      dim(it.widthM, it.width, IC.w);
      dim(it.heightM, it.height, IC.h);
      // A typed quantity stays text unless it is just a number (optionally with its unit).
      const plain = !it.custom.qty || !it.qtyText.replace(/-?\d[\d,]*(?:[.,]\d+)?/, '').replace(/יח['׳]|מ["״]ר|מ['׳]|מטר|\s/g, '');
      if (it.qty !== null && !plain) textQty.add(it.unit);
      if (it.qty !== null && plain) {
        row.getCell(IC.qty).value = it.qty;
        row.getCell(IC.qty).numFmt = it.kind === 'count' && Number.isInteger(it.qty) ? '#,##0' : NUM;
      } else row.getCell(IC.qty).value = it.qtyText;
      row.getCell(IC.unit).value = it.unit;
      if (it.m2) {
        row.getCell(IC.m2).value = round6(it.m2);
        row.getCell(IC.m2).numFmt = NUM;
      }
      row.getCell(IC.extra).value = it.extra || null;
      style(row);
      r++;
    }
    const last = r - 1;
    const hasRows = (u: ItemUnit) => g.rows.some((x) => x.unit === u && x.qty !== null);
    const qtyUnits = (['יח׳', 'מ׳'] as const).filter((u) => hasRows(u));
    const m2 = round6(g.subtotal.m2);
    // One subtotal row per quantity unit; the m² sum sits on the first of them.
    const n = Math.max(1, qtyUnits.length);
    for (let i = 0; i < n; i++) {
      const u = qtyUnits[i];
      const row = ws.getRow(r);
      row.getCell(1).value = `סה״כ ${g.name}`;
      if (u) {
        const v = round6(g.subtotal[UNIT_FIELD[u]]);
        const U = L(IC.unit);
        const Q = L(IC.qty);
        row.getCell(IC.qty).value = textQty.has(u)
          ? v
          : { formula: `SUMIF(${U}${first}:${U}${last},"${u.replace(/"/g, '""')}",${Q}${first}:${Q}${last})`, result: v };
        row.getCell(IC.qty).numFmt = u === 'יח׳' ? fmtQty(v) : NUM;
        row.getCell(IC.unit).value = u;
        subCells[u].push(`${Q}${r}`);
      }
      if (i === 0) {
        const M = L(IC.m2);
        row.getCell(IC.m2).value = { formula: `SUM(${M}${first}:${M}${last})`, result: m2 };
        row.getCell(IC.m2).numFmt = NUM;
        subCells.m2.push(`${M}${r}`);
      }
      row.font = { bold: true };
      style(row, SUBTOTAL_FILL);
      r++;
    }
  }
  if (table.groups.length > 1) {
    const qtyUnits = (['יח׳', 'מ׳'] as const).filter((u) => subCells[u].length);
    const n = Math.max(1, qtyUnits.length);
    for (let i = 0; i < n; i++) {
      const u = qtyUnits[i];
      const row = ws.getRow(r);
      row.getCell(1).value = 'סה״כ כללי';
      if (u) {
        const v = round6(table.total[UNIT_FIELD[u]]);
        row.getCell(IC.qty).value = { formula: subCells[u].join('+'), result: v };
        row.getCell(IC.qty).numFmt = u === 'יח׳' ? fmtQty(v) : NUM;
        row.getCell(IC.unit).value = u;
      }
      if (i === 0) {
        row.getCell(IC.m2).value = { formula: subCells.m2.join('+'), result: round6(table.total.m2) };
        row.getCell(IC.m2).numFmt = NUM;
      }
      row.font = { bold: true, size: 12 };
      style(row, TOTAL_FILL);
      r++;
    }
  }
  if (table.uncalibrated) {
    r++;
    ws.mergeCells(r, 1, r, COLS);
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
  wb.creator = 'PDF Viewer';
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;
  if (input.items) itemsSheet(wb, input, input.items);
  tableSheet(wb, 'מדידות', input.measurementRows, [6, 9, 22, 14, 7, 12, 11, 11, 8, 10, 16, 16, 14, 14]);
  const notes = input.notes.length ? [['מס׳', 'סוג', 'שם', 'קטגוריה', 'דף', 'טקסט'], ...input.notes] : [['הערות'], ['אין הערות בדפים שנבחרו']];
  const ns = tableSheet(wb, 'הערות', notes, [6, 9, 18, 14, 6, 70], 99);
  ns.getColumn(6).alignment = { wrapText: true, vertical: 'top' };
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
