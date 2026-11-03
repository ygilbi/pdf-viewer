import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { AreaMeasurement, Calibration, Point } from '../core/types';
import { DEFAULT_CATEGORIES, buildMeasurementRows } from '../core/measurementEngine';
import { buildBoq, emptyPriceBook, resolvePricing } from './boq';
import { BOQ_FIRST_ROW, buildXlsx } from './xlsxExport';

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
});
