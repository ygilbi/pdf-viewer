import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { AreaMeasurement, Calibration, Point } from '../core/types';
import { DEFAULT_CATEGORIES, buildMeasurementRows } from '../core/measurementEngine';
import { ITEMS_HEADER_ROW, buildXlsx } from './xlsxExport';
import { buildItemTable } from '../core/itemTable';

const P = (x: number, y: number): Point => ({ x, y });
const cal: Calibration = { pixelsPerMeter: 10, p1: P(0, 0), p2: P(100, 0), meters: 10 };
const ms: AreaMeasurement[] = [
  { id: 'f', page: 1, kind: 'area', label: 'חזית', points: [P(0, 0), P(240, 0), P(240, 140), P(0, 140)], color: '#000', category: 'cladding' },
  { id: 'n', page: 1, kind: 'count', label: 'W1', points: [P(1, 1), P(2, 2)], color: '#000', category: 'windows', item: { width: 1.5, height: 1.4 } },
];

describe('buildXlsx', () => {
  it('writes RTL measurement and notes sheets (no items sheet when no items table is given)', async () => {
    const bytes = await buildXlsx({
      measurementRows: buildMeasurementRows(ms, { 1: cal }),
      notes: [['1', 'הערה', 'n', '', '1', 'שלום']],
      title: 't',
      dateText: '1.1.2026',
      files: ['a.pdf'],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['מדידות', 'הערות']);
    expect(wb.getWorksheet('מדידות')!.views[0].rightToLeft).toBe(true);
    expect(wb.getWorksheet('הערות')!.getCell('F2').value).toBe('שלום');
    const meas = wb.getWorksheet('מדידות')!;
    expect(meas.getCell('A1').value).toBe('מס׳');
    expect(meas.getCell('F2').value).toBe(336);
    expect(meas.getCell('M3').value).toBe(4.2);
  });

  it('puts the items table (טבלת פריטים) first: owner\'s columns + unit, numeric quantities, SUMIF subtotals (+ counted items\' area), grand total', async () => {
    const items: AreaMeasurement[] = [
      ...ms.map((m) => (m.id === 'f' ? { ...m, asItem: true, itemName: 'קיר מסך CW-1', system: 'סטיק', extra: 'זכוכית 8.8.2' } : m)),
      { id: 'n2', page: 1, kind: 'count', label: 'W2', points: [P(5, 5), P(6, 6), P(7, 7)], color: '#000', category: 'windows', qtyText: '3 + 1 רזרבה' },
      { id: 'd1', page: 1, kind: 'count', label: 'D1', points: [P(5, 5)], color: '#000', category: 'doors', system: 'קליל' },
      // counted panels with measured dims in an area category: 3 × 2×1 = 6 m² on top of the SUMIF
      { id: 'c1', page: 1, kind: 'count', label: 'P1', points: [P(1, 1), P(2, 2), P(3, 3)], color: '#000', category: 'cladding', item: { width: 2, height: 1 } },
    ];
    const bytes = await buildXlsx({
      items: buildItemTable(items, { 1: cal }, DEFAULT_CATEGORIES),
      measurementRows: buildMeasurementRows(items, { 1: cal }),
      notes: [],
      title: 'פרויקט',
      dateText: '1.1.2026',
      files: ['a.pdf'],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['טבלת פריטים', 'מדידות', 'הערות']);
    const ws = wb.getWorksheet('טבלת פריטים')!;
    expect(ws.views[0]).toMatchObject({ rightToLeft: true, state: 'frozen', ySplit: ITEMS_HEADER_ROW });
    const h = ITEMS_HEADER_ROW;
    expect(ws.getCell('A1').value).toBe('טבלת פריטים');
    expect((ws.getRow(h).values as unknown[]).slice(1)).toEqual(['שם פריט', 'קטגוריה', 'מערכת', 'גודל', 'כמות', 'יחידה', 'מידע נוסף']);
    const row = (r: number) => (ws.getRow(r).values as unknown[]).slice(1, 8);
    // windows: W1 (2, numeric; size = dims + unit area), W2 (typed text "3 + 1 רזרבה" stays text),
    // units subtotal = value (text in range), then an m² subtotal = W1's area 2 × 1.5×1.4 (no m² rows → value)
    expect(row(h + 1).slice(0, 6)).toEqual(['W1', 'חלונות', undefined, '150×140 (2.10 מ״ר)', 2, 'יח׳']);
    expect(row(h + 2).slice(4, 6)).toEqual(['3 + 1 רזרבה', 'יח׳']);
    expect(row(h + 3)[0]).toBe('סה״כ חלונות');
    expect(ws.getCell(`E${h + 3}`).value).toBe(5);
    expect(ws.getCell(`A${h + 3}`).font?.bold).toBe(true);
    expect((ws.getCell(`A${h + 3}`).fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FFE6EEF8');
    expect(row(h + 4)[0]).toBe('סה״כ חלונות');
    expect(ws.getCell(`E${h + 4}`).value).toBe(4.2);
    expect(ws.getCell(`F${h + 4}`).value).toBe('מ״ר');
    // doors: live SUMIF subtotal
    expect(row(h + 5).slice(0, 3)).toEqual(['D1', 'דלתות', 'קליל']);
    expect(ws.getCell(`E${h + 6}`).value).toMatchObject({ formula: `SUMIF(F${h + 5}:F${h + 5},"יח׳",E${h + 5}:E${h + 5})`, result: 1 });
    // cladding: curtain wall area as an item (m² number) + counted panels with dims
    expect(row(h + 7)).toEqual(['קיר מסך CW-1', 'חיפוי', 'סטיק', '24.00×14.00', 336, 'מ״ר', 'זכוכית 8.8.2']);
    expect(row(h + 8).slice(0, 6)).toEqual(['P1', 'חיפוי', undefined, '200×100 (2.00 מ״ר)', 3, 'יח׳']);
    expect(ws.getCell(`E${h + 9}`).value).toMatchObject({ formula: `SUMIF(F${h + 7}:F${h + 8},"יח׳",E${h + 7}:E${h + 8})`, result: 3 });
    // m² subtotal = SUMIF over the area rows + the panels' area (3 × 2×1), matching buildItemTable
    expect(ws.getCell(`E${h + 10}`).value).toMatchObject({ formula: `SUMIF(F${h + 7}:F${h + 8},"מ״ר",E${h + 7}:E${h + 8})+6`, result: 342 });
    // grand total: one row per unit, adding up the subtotals
    expect(row(h + 11).slice(0, 1)).toEqual(['סה״כ כללי']);
    expect(ws.getCell(`E${h + 11}`).value).toMatchObject({ formula: `E${h + 3}+E${h + 6}+E${h + 9}`, result: 9 });
    expect(ws.getCell(`F${h + 12}`).value).toBe('מ״ר');
    expect(ws.getCell(`E${h + 12}`).value).toMatchObject({ formula: `E${h + 4}+E${h + 10}`, result: 346.2 });
  });
});
