import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { AreaMeasurement, Calibration, Point } from '../core/types';
import { DEFAULT_CATEGORIES, buildMeasurementRows } from '../core/measurementEngine';
import { buildBoq, emptyPriceBook, resolvePricing } from './boq';
import { BOQ_FIRST_ROW, ITEMS_HEADER_ROW, buildXlsx } from './xlsxExport';
import { buildItemTable } from '../core/itemTable';

const P = (x: number, y: number): Point => ({ x, y });
const cal: Calibration = { pixelsPerMeter: 10, p1: P(0, 0), p2: P(100, 0), meters: 10 };
const ms: AreaMeasurement[] = [
  { id: 'f', page: 1, kind: 'area', label: 'חזית', points: [P(0, 0), P(240, 0), P(240, 140), P(0, 140)], color: '#000', category: 'cladding' },
  { id: 'n', page: 1, kind: 'count', label: 'W1', points: [P(1, 1), P(2, 2)], color: '#000', category: 'windows', item: { width: 1.5, height: 1.4 } },
];

describe('buildXlsx', () => {
  it('writes an RTL BOQ sheet with live formulas + measurement and notes sheets', async () => {
    const pricing = resolvePricing(emptyPriceBook(), {
      categories: { cladding: { price: 450, wastePct: 10 }, windows: { price: 900 } },
      settings: { discountPct: 5, projectName: 'פרויקט' },
    });
    const boq = buildBoq({ measurements: ms, calibrations: { 1: cal }, categories: DEFAULT_CATEGORIES, pricing });
    const bytes = await buildXlsx({
      boq,
      measurementRows: buildMeasurementRows(ms, { 1: cal }),
      notes: [],
      title: 't',
      dateText: '1.1.2026',
      files: ['a.pdf'],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['כתב כמויות', 'מדידות', 'הערות']);
    const ws = wb.getWorksheet('כתב כמויות')!;
    expect(ws.views[0].rightToLeft).toBe(true);
    expect(ws.getCell('C2').value).toBe('פרויקט');
    const r = BOQ_FIRST_ROW;
    // windows first (category order), unit = units (count-only category)
    expect(ws.getCell(`B${r}`).value).toBe('חלונות');
    expect(ws.getCell(`E${r}`).value).toBe(2);
    expect(ws.getCell(`J${r}`).value).toMatchObject({ formula: `ROUND(G${r}*(H${r}+I${r}),2)`, result: 1800 });
    expect(ws.getCell(`G${r + 1}`).value).toMatchObject({ formula: `ROUND(E${r + 1}*(1+F${r + 1}),2)`, result: 369.6 });
    const sub = ws.getCell(`J${r + 2}`).value as { formula: string; result: number };
    expect(sub.formula).toBe(`SUM(J${r}:J${r + 1})`);
    expect(sub.result).toBe(boq.subtotal);
    const total = ws.getCell(`J${r + 6}`).value as { formula: string; result: number };
    expect(total.formula).toBe(`J${r + 4}+J${r + 5}`);
    expect(total.result).toBe(boq.total);
    expect(ws.getCell(`I${r + 3}`).value).toBe(0.05);
    expect(ws.getCell(`I${r + 5}`).value).toBe(0.18);
    const meas = wb.getWorksheet('מדידות')!;
    expect(meas.getCell('A1').value).toBe('מס׳');
    expect(meas.getCell('F2').value).toBe(336);
    expect(meas.getCell('M3').value).toBe(4.2);
  });

  it('puts the items table (טבלת פריטים) first: owner\'s columns + unit, numeric quantities, SUMIF subtotals, grand total', async () => {
    const items: AreaMeasurement[] = [
      ...ms.map((m) => (m.id === 'f' ? { ...m, asItem: true, itemName: 'קיר מסך CW-1', system: 'סטיק', extra: 'זכוכית 8.8.2' } : m)),
      { id: 'n2', page: 1, kind: 'count', label: 'W2', points: [P(5, 5), P(6, 6), P(7, 7)], color: '#000', category: 'windows', qtyText: '3 + 1 רזרבה' },
      { id: 'd1', page: 1, kind: 'count', label: 'D1', points: [P(5, 5)], color: '#000', category: 'doors', system: 'קליל' },
    ];
    const boq = buildBoq({ measurements: items, calibrations: { 1: cal }, categories: DEFAULT_CATEGORIES, pricing: resolvePricing(emptyPriceBook(), emptyPriceBook()) });
    const bytes = await buildXlsx({
      items: buildItemTable(items, { 1: cal }, DEFAULT_CATEGORIES),
      boq,
      measurementRows: buildMeasurementRows(items, { 1: cal }),
      notes: [],
      title: 'פרויקט',
      dateText: '1.1.2026',
      files: ['a.pdf'],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['טבלת פריטים', 'כתב כמויות', 'מדידות', 'הערות']);
    const ws = wb.getWorksheet('טבלת פריטים')!;
    expect(ws.views[0]).toMatchObject({ rightToLeft: true, state: 'frozen', ySplit: ITEMS_HEADER_ROW });
    const h = ITEMS_HEADER_ROW;
    expect(ws.getCell('A1').value).toBe('טבלת פריטים');
    expect((ws.getRow(h).values as unknown[]).slice(1)).toEqual(['שם פריט', 'קטגוריה', 'מערכת', 'גודל', 'כמות', 'יחידה', 'מידע נוסף']);
    const row = (r: number) => (ws.getRow(r).values as unknown[]).slice(1, 8);
    // windows: W1 (2, numeric), W2 (typed text "3 + 1 רזרבה" stays text), subtotal = value (text in range)
    expect(row(h + 1).slice(0, 6)).toEqual(['W1', 'חלונות', undefined, '150×140', 2, 'יח׳']);
    expect(row(h + 2).slice(4, 6)).toEqual(['3 + 1 רזרבה', 'יח׳']);
    expect(row(h + 3)[0]).toBe('סה״כ חלונות');
    expect(ws.getCell(`E${h + 3}`).value).toBe(5);
    expect(ws.getCell(`A${h + 3}`).font?.bold).toBe(true);
    expect((ws.getCell(`A${h + 3}`).fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FFE6EEF8');
    // doors: live SUMIF subtotal
    expect(row(h + 4).slice(0, 3)).toEqual(['D1', 'דלתות', 'קליל']);
    expect(ws.getCell(`E${h + 5}`).value).toMatchObject({ formula: `SUMIF(F${h + 4}:F${h + 4},"יח׳",E${h + 4}:E${h + 4})`, result: 1 });
    // curtain wall area as an item: m² number
    expect(row(h + 6)).toEqual(['קיר מסך CW-1', 'חיפוי', 'סטיק', '24.00×14.00', 336, 'מ״ר', 'זכוכית 8.8.2']);
    expect(ws.getCell(`E${h + 7}`).value).toMatchObject({ formula: `SUMIF(F${h + 6}:F${h + 6},"מ״ר",E${h + 6}:E${h + 6})`, result: 336 });
    // grand total: one row per unit, adding up the subtotals
    expect(row(h + 8).slice(0, 1)).toEqual(['סה״כ כללי']);
    expect(ws.getCell(`E${h + 8}`).value).toMatchObject({ formula: `E${h + 3}+E${h + 5}`, result: 6 });
    expect(ws.getCell(`F${h + 9}`).value).toBe('מ״ר');
    expect(ws.getCell(`E${h + 9}`).value).toMatchObject({ formula: `E${h + 7}`, result: 336 });
  });
});
