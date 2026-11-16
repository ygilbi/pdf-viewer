import { describe, expect, it } from 'vitest';
import { buildGilboaPayload, encodePayload, gilboaImportUrl, normalizeGilboaBase } from './gilboaExport';
import type { AreaMeasurement, Calibration } from './types';

// קנה מידה: 100 יחידות דף = 1 מטר
const cal: Record<number, Calibration> = { 1: { pixelsPerMeter: 100, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, meters: 1 } };
const rect = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

describe('שלח לגלבוע', () => {
  it('פתח: רוחב וגובה מדויקים, שטח והיקף; ספירה: כמות; אורך: מטרים; קטגוריה בשם', () => {
    const ms: AreaMeasurement[] = [
      { id: '1', page: 1, label: 'פתח 1', kind: 'deduct', points: rect(10, 10, 120, 150), color: '#f00', category: 'windows' },
      { id: '2', page: 1, label: 'W7', kind: 'count', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], color: '#f00', category: 'windows' },
      { id: '3', page: 1, label: 'קו 1', kind: 'length', points: [{ x: 0, y: 0 }, { x: 0, y: 1250 }], color: '#f00', category: 'railings' },
      { id: '4', page: 2, label: 'פתח 2', kind: 'deduct', points: rect(0, 0, 100, 100), color: '#f00' }, // עמוד בלי כיול
    ];
    const p = buildGilboaPayload(ms, cal, [{ id: 'windows', name: 'חלונות', color: '#00f' }, { id: 'railings', name: 'מעקות', color: '#0f0' }], 'חזיתות.pdf');
    expect(p.file).toBe('חזיתות.pdf');
    expect(p.measurements[0]).toMatchObject({ kind: 'deduct', category: 'חלונות', widthM: 1.2, heightM: 1.5, areaM2: 1.8, perimeterM: 5.4 });
    expect(p.measurements[1]).toMatchObject({ kind: 'count', count: 3 });
    expect(p.measurements[2]).toMatchObject({ kind: 'length', lengthM: 12.5, category: 'מעקות' });
    expect(p.measurements[3]).toMatchObject({ areaM2: null, widthM: null, category: '' });
  });

  it('כתובת: base64url של JSON (עברית נשמרת), וכתובת האפליקציה מנורמלת', () => {
    const p = buildGilboaPayload([], cal, [], 'בניין א.pdf');
    const url = gilboaImportUrl('https://gilboa.example.com/', p);
    expect(url.startsWith('https://gilboa.example.com/import-takeoff#takeoff=')).toBe(true);
    const b64 = encodePayload(p).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))).file).toBe('בניין א.pdf');
    expect(normalizeGilboaBase('gilboa.example.com/dashboard')).toBe('https://gilboa.example.com');
    expect(normalizeGilboaBase('http://evil.example.com')).toBeNull();
    expect(normalizeGilboaBase('')).toBeNull();
  });

  it('counted items carry width, height and the area of one item (items-table size wins)', async () => {
    const { buildGilboaPayload, parseSizeCm } = await import('./gilboaExport');
    const pts = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    const p = buildGilboaPayload(
      [
        { id: 'c1', kind: 'count', label: 'ספירה 1', page: 1, points: pts, item: { width: 1.5, height: 1.4, code: 'W1' } } as never,
        { id: 'c2', kind: 'count', label: 'דלת', page: 1, points: pts.slice(0, 1), sizeText: '90×210', itemName: 'D1' } as never,
      ],
      {},
      [],
      'a.pdf',
    );
    expect(p.measurements[0]).toMatchObject({ kind: 'count', label: 'W1', count: 3, widthM: 1.5, heightM: 1.4, areaM2: 2.1 });
    expect(p.measurements[1]).toMatchObject({ label: 'D1', count: 1, widthM: 0.9, heightM: 2.1, areaM2: 1.89 });
    expect(parseSizeCm('120 x 200')).toEqual({ w: 1.2, h: 2 });
    expect(parseSizeCm('לא')).toBeNull();
  });
});
