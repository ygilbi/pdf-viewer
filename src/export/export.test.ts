import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { paragraphIsRtl, toVisual } from './bidi';
import { pageGeometry, pdfToViewport, viewportSize, viewportToPdf } from './pageTransform';
import { formatPageRanges, parsePageRanges } from './pageSelection';
import { hatchSegments } from './hatch';
import { buildExportPdf, numberNotes } from './buildPdf';
import { buildExportCsv } from './csvExport';
import { ITEM_COLUMNS } from '../core/itemTable';
import { forPdfLib, shape, wrapCell } from './pdfCommon';
import fontkit from '@pdf-lib/fontkit';
import { DEFAULT_CATEGORIES } from '../core/measurementEngine';
import { DEFAULT_CSV_OPTIONS, DEFAULT_PDF_OPTIONS, type PdfBuildInput } from './types';
import type { AreaMeasurement, Calibration } from '../core/types';

// Node builtins without @types/node (typed as any).
const nodeFs = () => import('node:fs' as string) as Promise<{ readFileSync(p: string | URL): Uint8Array }>;
const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs' as string);

describe('bidi toVisual', () => {
  it('reverses Hebrew, keeps numbers LTR', () => {
    expect(toVisual('שטח 12.50 מ״ר')).toBe('ר״מ 12.50 חטש');
    expect(toVisual('נטו -3.25')).toBe('-3.25 וטנ');
    expect(toVisual('1,234.56 מ׳')).toBe('׳מ 1,234.56');
  });
  it('keeps Latin runs and number+Latin groups in order', () => {
    expect(toVisual('חלון W1 ×12')).toBe('W1 ×12 ןולח');
    expect(toVisual('קומה A-101')).toBe('A-101 המוק');
  });
  it('mirrors brackets inside RTL', () => {
    expect(toVisual('שטח (נטו)')).toBe('(וטנ) חטש');
  });
  it('leaves pure LTR text and numbers alone', () => {
    expect(toVisual('Hello 123')).toBe('Hello 123');
    expect(toVisual('12.5')).toBe('12.5');
    expect(toVisual('')).toBe('');
  });
  it('LTR paragraph with a Hebrew word', () => {
    expect(toVisual('Page שלום 3', false)).toBe('Page 3 םולש'); // UBA: the number joins the RTL run
  });
  it('paragraph direction', () => {
    expect(paragraphIsRtl('abc שלום')).toBe(false);
    expect(paragraphIsRtl('12 שלום')).toBe(true);
    expect(paragraphIsRtl('123')).toBe(true);
  });
});

describe('fontkit glyph order', () => {
  it('glyphs come out in visual order for Hebrew, mixed and Latin strings', async () => {
    const { regular } = await fonts();
    const font = fontkit.create(regular as Uint8Array);
    for (const logical of ['סיכום כמויות', 'עמוד 3', 'תאריך: 1.11.2026', 'נטו 12.50 מ״ר', 'לבדוק (A-101) גובה', 'W1 ×3', 'demo.pdf']) {
      const visual = toVisual(logical);
      const glyphs = font.layout(forPdfLib(visual)).glyphs;
      const got = glyphs.map((g: { codePoints: number[] }) => String.fromCodePoint(...g.codePoints)).join('');
      expect(got).toBe(visual);
    }
  });
});

describe('shape: mixed Hebrew / Latin lines', () => {
  it('draws single-script pieces so every glyph lands in visual order', async () => {
    const { regular } = await fonts();
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const pdfFont = await doc.embedFont(regular);
    const font = fontkit.create(regular as Uint8Array);
    for (const logical of ['Low-E, פרזול נסתר, ידית', 'זיגוג Low-E', 'קיר מסך CW-1', 'Schüco AWS 75', 'דלת D1 אלומיניום']) {
      const s = shape(pdfFont, logical, 10, true);
      const got = s.parts
        .map((p) => font.layout(p.text).glyphs.map((g: { codePoints: number[] }) => String.fromCodePoint(...g.codePoints)).join(''))
        .join('');
      expect(got).toBe(toVisual(logical, true));
      expect(s.parts[0].dx).toBe(0);
    }
  });
  it('wrapCell breaks long words and ends a cut cell with an ellipsis', async () => {
    const { regular } = await fonts();
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const f = await doc.embedFont(regular);
    const lines = wrapCell(f, 'א'.repeat(80) + ' שלום עולם '.repeat(20), 9, 60, 3);
    expect(lines.length).toBe(3);
    for (const l of lines) expect(f.widthOfTextAtSize(l, 9)).toBeLessThanOrEqual(60.01);
    expect(lines[2].endsWith('…')).toBe(true);
    expect(wrapCell(f, 'קצר', 9, 60, 3)).toEqual(['קצר']);
  });
});

describe('page ranges', () => {
  it('parses', () => {
    expect(parsePageRanges('1-3,7', 10)).toEqual({ ok: true, pages: [1, 2, 3, 7] });
    expect(parsePageRanges(' 3 , 1 – 2 ', 5)).toEqual({ ok: true, pages: [1, 2, 3] });
    expect(parsePageRanges('8-', 10)).toEqual({ ok: true, pages: [8, 9, 10] });
    expect(parsePageRanges('', 10)).toEqual({ ok: true, pages: [] });
    expect(parsePageRanges('0-2', 10).ok).toBe(false);
    expect(parsePageRanges('11', 10).ok).toBe(false);
    expect(parsePageRanges('a', 10).ok).toBe(false);
  });
  it('formats', () => {
    expect(formatPageRanges([7, 1, 2, 3])).toBe('1-3,7');
    expect(formatPageRanges([])).toBe('');
  });
});

describe('hatch', () => {
  it('clips 45° lines to a square', () => {
    const segs = hatchSegments(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      2,
    );
    expect(segs.length).toBeGreaterThan(5);
    for (const [a, b] of segs) {
      for (const p of [a, b]) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-9);
        expect(p.x).toBeLessThanOrEqual(10 + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(-1e-9);
        expect(p.y).toBeLessThanOrEqual(10 + 1e-9);
      }
      expect(Math.abs(b.x - a.x - (b.y - a.y))).toBeLessThan(1e-9); // 45°
    }
  });
});

describe('viewport ↔ PDF transform (checked against pdf.js)', () => {
  it.each([0, 90, 180, 270, -90, 450])('rotation %i with CropBox offset', async (rot) => {
    const d = await PDFDocument.create();
    const p = d.addPage([600, 800]);
    p.setMediaBox(-5, 3, 600, 800);
    p.setCropBox(20, 40, 500, 700);
    p.setRotation(degrees(rot));
    const doc = await (await pdfjs()).getDocument({ data: await d.save() }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const g = pageGeometry(p.getMediaBox(), p.getCropBox(), p.getRotation().angle);
    const size = viewportSize(g);
    expect(size.width).toBeCloseTo(vp.width, 6);
    expect(size.height).toBeCloseTo(vp.height, 6);
    for (const pt of [
      { x: 20, y: 40 },
      { x: 520, y: 40 },
      { x: 133.3, y: 611.7 },
    ]) {
      const [vx, vy] = vp.convertToViewportPoint(pt.x, pt.y);
      const mine = pdfToViewport(g, pt);
      expect(mine.x).toBeCloseTo(vx, 6);
      expect(mine.y).toBeCloseTo(vy, 6);
      const back = viewportToPdf(g, mine);
      expect(back.x).toBeCloseTo(pt.x, 6);
      expect(back.y).toBeCloseTo(pt.y, 6);
    }
    await doc.destroy();
  });

  it('crop box larger than media box is clipped like pdf.js', () => {
    const g = pageGeometry({ x: 0, y: 0, width: 100, height: 200 }, { x: -10, y: -10, width: 300, height: 300 }, 0);
    expect(g).toEqual({ rotation: 0, x0: 0, y0: 0, x1: 100, y1: 200 });
  });
});

// ---------------------------------------------------------------------------

const cal: Calibration = { pixelsPerMeter: 28.346, p1: { x: 100, y: 700 }, p2: { x: 383.46, y: 700 }, meters: 10 };
const ms: AreaMeasurement[] = [
  { id: 'a', page: 1, label: 'חזית 1', kind: 'area', color: '#1f77b4', category: 'windows', points: [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 400 }, { x: 100, y: 400 }] },
  { id: 'd', page: 1, label: 'פתח 1', kind: 'deduct', color: '#e11d48', points: [{ x: 150, y: 150 }, { x: 200, y: 150 }, { x: 200, y: 200 }, { x: 150, y: 200 }] },
  { id: 'l', page: 2, label: 'קו 1', kind: 'length', color: '#2ca02c', points: [{ x: 50, y: 50 }, { x: 300, y: 50 }] },
  { id: 'c', page: 2, label: 'W1', kind: 'count', color: '#ff7f0e', category: 'windows', points: [{ x: 60, y: 300 }, { x: 90, y: 300 }] },
  { id: 'n', page: 2, label: 'הערה 1', kind: 'note', color: '#dc2626', text: 'לבדוק מידות 120 ס"מ', points: [{ x: 200, y: 200 }] },
  { id: 'r', page: 1, label: 'ענן 1', kind: 'cloud', color: '#dc2626', points: [{ x: 420, y: 420 }, { x: 500, y: 480 }] },
  { id: 'x', page: 3, label: 'חזית 2', kind: 'area', color: '#9467bd', points: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }] },
];

async function fonts() {
  const fs = await nodeFs();
  return {
    regular: fs.readFileSync(new URL('./fonts/Alef-Regular.ttf', import.meta.url)),
    bold: fs.readFileSync(new URL('./fonts/Alef-Bold.ttf', import.meta.url)),
  };
}

describe('buildExportPdf', () => {
  it('copies the selected pages (incl. a rotated one) and appends a summary', async () => {
    const src = await PDFDocument.create();
    for (let i = 0; i < 3; i++) {
      const p = src.addPage([595, 842]);
      p.drawText(`page ${i + 1}`, { x: 50, y: 800 });
      if (i === 1) p.setRotation(degrees(90));
    }
    const bytes = await src.save();
    const input: PdfBuildInput = {
      docs: [{ id: 'doc1', name: 'test.pdf' }],
      bytes: { doc1: bytes },
      pages: [
        { globalPage: 1, docId: 'doc1', localPage: 1 },
        { globalPage: 2, docId: 'doc1', localPage: 2 },
      ],
      pageSizes: { 1: { width: 595, height: 842 }, 2: { width: 842, height: 595 }, 3: { width: 595, height: 842 } },
      measurements: ms,
      calibrations: { 1: cal, 2: cal },
      categories: DEFAULT_CATEGORIES,
      options: { ...DEFAULT_PDF_OPTIONS, legend: true },
      fonts: await fonts(),
      title: 'בדיקה',
    };
    const stages = new Set<string>();
    const out = await buildExportPdf(input, (s) => stages.add(s));
    expect([...stages]).toEqual(['load', 'pages', 'summary', 'save']);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3); // 2 drawing pages + 1 summary page
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    // pdf.js can open it and sees the original text.
    const pd = await (await pdfjs()).getDocument({ data: out }).promise;
    const tc = await (await pd.getPage(1)).getTextContent();
    expect(tc.items.map((i: { str: string }) => i.str).join(' ')).toContain('page 1');
    await pd.destroy();
  });

  it('blank pages when drawings are off; cancel aborts', async () => {
    const input: PdfBuildInput = {
      docs: [{ id: 'doc1', name: 'x.pdf' }],
      bytes: {},
      pages: [{ globalPage: 1, docId: 'doc1', localPage: 1 }],
      pageSizes: { 1: { width: 500, height: 300 } },
      measurements: ms,
      calibrations: { 1: cal },
      categories: DEFAULT_CATEGORIES,
      options: { ...DEFAULT_PDF_OPTIONS, drawings: false, summary: false, items: false },
      fonts: await fonts(),
      title: 'x',
    };
    const doc = await PDFDocument.load(await buildExportPdf(input));
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 500, height: 300 });
    await expect(buildExportPdf(input, undefined, () => true)).rejects.toThrow('בוטל');
  });

  it('turns link areas into PDF /Link annotations to the exported target page', async () => {
    const link: AreaMeasurement = { id: 'L1', page: 1, kind: 'link', label: 'קישור 1', color: '#0284c7', points: [{ x: 50, y: 40 }, { x: 150, y: 100 }, { x: 300, y: 60 }], fontSize: 20, text: 'A1', refLabel: 'SIM', targetPage: 2 };
    const dangling: AreaMeasurement = { ...link, id: 'L2', targetPage: 9 };
    const input: PdfBuildInput = {
      docs: [{ id: 'doc1', name: 'x.pdf' }],
      bytes: {},
      pages: [{ globalPage: 1, docId: 'doc1', localPage: 1 }, { globalPage: 2, docId: 'doc1', localPage: 2 }],
      pageSizes: { 1: { width: 500, height: 300 }, 2: { width: 500, height: 300 } },
      measurements: [link, dangling],
      calibrations: {},
      categories: DEFAULT_CATEGORIES,
      options: { ...DEFAULT_PDF_OPTIONS, drawings: false, summary: false, items: false },
      fonts: await fonts(),
      title: 'x',
    };
    const doc = await PDFDocument.load(await buildExportPdf(input));
    const annots = doc.getPage(0).node.Annots();
    expect(annots?.size()).toBe(1); // the link to page 9 (not exported) is skipped
    const a = doc.context.lookup(annots!.get(0)) as unknown as { get(k: unknown): unknown };
    const { PDFName } = await import('pdf-lib');
    type Arr = { asRectangle(): unknown; get(i: number): unknown };
    const rect = (a.get(PDFName.of('Rect')) as Arr).asRectangle();
    expect(rect).toEqual({ x: 50, y: 200, width: 270, height: 60 }); // bubble + head (r 20 at 300,60); y flipped
    const dest = a.get(PDFName.of('Dest')) as Arr;
    expect(dest.get(0)).toBe(doc.getPage(1).ref);
  });

  it('numbers notes in page order', () => {
    const m = numberNotes({
      pages: [
        { globalPage: 2, docId: 'a', localPage: 2 },
        { globalPage: 1, docId: 'a', localPage: 1 },
      ],
      measurements: [
        { id: 'n1', page: 1, label: '', kind: 'note', color: '', points: [] },
        { id: 'n2', page: 2, label: '', kind: 'note', color: '', points: [] },
      ],
    });
    expect(m.get('n2')).toBe(1);
    expect(m.get('n1')).toBe(2);
  });
});

describe('buildExportCsv', () => {
  it('only selected pages, BOM, filters', () => {
    const csv = buildExportCsv(ms, { 1: cal, 2: cal }, DEFAULT_CATEGORIES, [1, 2], DEFAULT_CSV_OPTIONS);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('חזית 1');
    expect(csv).not.toContain('חזית 2'); // page 3 not selected
    expect(csv).toContain('לבדוק מידות');
    const onlyCounts = buildExportCsv(ms, { 1: cal }, DEFAULT_CATEGORIES, [1, 2], {
      ...DEFAULT_CSV_OPTIONS,
      kinds: ['count'],
      notes: false,
      totals: false,
      categoryTotals: false,
    });
    const lines = onlyCounts.trim().split('\r\n');
    expect(lines.length).toBe(2); // header + W1
    expect(lines[1]).toContain('W1');
    const noRows = buildExportCsv(ms, { 1: cal }, DEFAULT_CATEGORIES, [1], { ...DEFAULT_CSV_OPTIONS, rows: false, notes: false });
    expect(noRows).not.toContain('פתח 1');
    expect(noRows).toContain('נטו');
  });
});

// ---------------------------------------------------------------------------
// טבלת פריטים

const sq = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
/** Many items over three categories (+ an uncategorised one) → the items table spans pages. */
function itemFixture(n = 60): AreaMeasurement[] {
  const out: AreaMeasurement[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `w${i}`, page: 1, kind: 'count', label: `W${i + 1}`, color: '#ff7f0e', category: i % 3 ? 'windows' : 'doors',
      points: Array.from({ length: 1 + (i % 4) }, (_, k) => ({ x: 20 + k * 10, y: 20 + i })),
      item: { width: 1.2, height: 1.5, code: `W${i + 1}` }, system: i % 2 ? 'קליל 4400' : 'Schüco AWS 75',
      ...(i === 5 ? { extra: 'זיגוג בידודי 6+12+6 עם ציפוי Low-E, פרזול נסתר, ידית נעילה, רשת נגד יתושים, אטימה כפולה ובדיקת עמידות לרוח לפי ת״י 1068 — הערה ארוכה במיוחד שאמורה להיחתך' } : {}),
    });
  }
  out.push({ id: 'cw', page: 1, kind: 'area', label: 'חזית', color: '#1f77b4', category: 'curtain-wall', points: sq(100, 100, 300, 200), asItem: true, itemName: 'קיר מסך CW-1', system: 'קיר מסך סטיק' });
  out.push({ id: 'cwd', page: 1, kind: 'deduct', label: 'פתח', color: '#e11d48', points: sq(120, 120, 28.346, 28.346) });
  out.push({ id: 'misc', page: 1, kind: 'length', label: 'מעקה', color: '#2ca02c', points: [{ x: 0, y: 500 }, { x: 283.46, y: 500 }], asItem: true });
  return out;
}

describe('items table export', () => {
  it('PDF: drawings + items table by default, paginated with a repeated header, RTL text', async () => {
    expect(DEFAULT_PDF_OPTIONS.items).toBe(true);
    expect(DEFAULT_PDF_OPTIONS.summary).toBe(false);
    const input: PdfBuildInput = {
      docs: [{ id: 'doc1', name: 'חזיתות.pdf' }],
      bytes: {},
      pages: [{ globalPage: 1, docId: 'doc1', localPage: 1 }],
      pageSizes: { 1: { width: 842, height: 595 } },
      measurements: itemFixture(40),
      calibrations: { 1: cal },
      categories: DEFAULT_CATEGORIES,
      options: { ...DEFAULT_PDF_OPTIONS, drawings: false },
      fonts: await fonts(),
      title: 'פרויקט בדיקה',
      dateText: '9.11.2026',
    };
    const out = await buildExportPdf(input);
    const doc = await PDFDocument.load(out);
    // 1 drawing page + 3 items pages (42 rows + subtotals + total; counted items' sizes carry their unit
    // area and their category subtotals an m² part too, so the rows are taller)
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getPage(1).getSize()).toEqual({ width: 595.28, height: 841.89 });
    const pd = await (await pdfjs()).getDocument({ data: out }).promise;
    const pageText = async (n: number) => (await (await pd.getPage(n)).getTextContent()).items.map((i: { str: string }) => i.str).join(' ');
    // pdf.js runs its own bidi → logical order (mixed-script lines come back as separate pieces)
    const has = (text: string, logical: string) => text.includes(logical);
    const p2 = await pageText(2);
    const p3 = await pageText(3);
    const p4 = await pageText(4);
    for (const h of [...ITEM_COLUMNS, 'טבלת פריטים']) expect(has(p2, h)).toBe(true);
    expect(has(p3, 'שם פריט') && has(p4, 'שם פריט')).toBe(true); // header repeated on the continuation pages
    const all = p2 + p3 + p4;
    expect(has(all, 'סה״כ דלתות')).toBe(true);
    expect(has(all, 'סה״כ כללי')).toBe(true);
    expect(has(all, 'CW-1') && has(all, 'קיר מסך סטיק')).toBe(true);
    expect(has(p2, '120×150')).toBe(true); // dimensions stay width×height
    expect(has(p2, '1.80')).toBe(true); // + the unit area (1.2 × 1.5 m²)
    expect(all).toContain('…'); // the long note is truncated
    await pd.destroy();

    // Items + generic summary: items first.
    const both = await buildExportPdf({ ...input, options: { ...input.options, summary: true } });
    const pd2 = await (await pdfjs()).getDocument({ data: both }).promise;
    expect(pd2.numPages).toBe(5);
    const last = (await (await pd2.getPage(5)).getTextContent()).items.map((i: { str: string }) => i.str).join(' ');
    expect(has(last, 'סיכום כמויות')).toBe(true);
    await pd2.destroy();
  });

  it('PDF: an items page with a notice when the pages have no items', async () => {
    const input: PdfBuildInput = {
      docs: [{ id: 'doc1', name: 'x.pdf' }],
      bytes: {},
      pages: [{ globalPage: 1, docId: 'doc1', localPage: 1 }],
      pageSizes: { 1: { width: 500, height: 300 } },
      measurements: ms.filter((m) => m.kind !== 'count'),
      calibrations: { 1: cal },
      categories: DEFAULT_CATEGORIES,
      options: { ...DEFAULT_PDF_OPTIONS, drawings: false },
      fonts: await fonts(),
      title: 'x',
    };
    expect((await PDFDocument.load(await buildExportPdf(input))).getPageCount()).toBe(2);
  });

  it('CSV: items table first (owner\'s columns, subtotals, total); filters apply; other sections unchanged', () => {
    const all = itemFixture(6);
    const onlyItems = buildExportCsv(all, { 1: cal }, DEFAULT_CATEGORIES, [1], {
      ...DEFAULT_CSV_OPTIONS, items: true, rows: false, categoryTotals: false, totals: false, notes: false,
    });
    expect(onlyItems.startsWith('\ufeff')).toBe(true);
    const lines = onlyItems.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(ITEM_COLUMNS.join(','));
    // m² column = the curtain wall (73.67) + the counted windows / doors' area: 13 × 1.2×1.5 = 23.40
    expect(lines).toContain('סה״כ כללי,,,,13 יח׳ · 10.00 מ׳,97.07,');
    expect(lines.some((l) => l.startsWith('סה״כ דלתות,'))).toBe(true);
    // the curtain wall's net area: 300×200 px ≈ 10.58×7.06 m = 74.67 m² minus the 1 m² opening
    expect(lines.find((l) => l.startsWith('קיר מסך CW-1'))).toBe('קיר מסך CW-1,קיר מסך,קיר מסך סטיק,10.58×7.06,73.67 מ״ר,73.67,');
    // kind / category filters select items; deductions still apply
    const cwOnly = buildExportCsv(all, { 1: cal }, DEFAULT_CATEGORIES, [1], {
      ...DEFAULT_CSV_OPTIONS, items: true, rows: false, categoryTotals: false, totals: false, notes: false, kinds: ['area'],
    });
    expect(cwOnly).toContain('73.67 מ״ר');
    expect(cwOnly).not.toContain('W1');
    // items + measurement rows: blank line between the two tables, measurement header after it
    const both = buildExportCsv(all, { 1: cal }, DEFAULT_CATEGORIES, [1], { ...DEFAULT_CSV_OPTIONS, items: true });
    const parts = both.slice(1).split('\r\n\r\n');
    expect(parts.length).toBe(2);
    expect(parts[1].startsWith(buildExportCsv(all, { 1: cal }, DEFAULT_CATEGORIES, [1], DEFAULT_CSV_OPTIONS).slice(1).split('\r\n')[0])).toBe(true);
    // default off → unchanged output
    expect(DEFAULT_CSV_OPTIONS.items).toBe(false);
  });
});
