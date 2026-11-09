import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { buildExportPdf } from './buildPdf';
import { buildExportCsv } from './csvExport';
import { DEFAULT_CATEGORIES } from '../core/measurementEngine';
import { DEFAULT_CSV_OPTIONS, DEFAULT_PDF_OPTIONS, type PdfBuildInput } from './types';
import type { AreaMeasurement } from '../core/types';

const nodeFs = () => import('node:fs' as string) as Promise<{ readFileSync(p: string | URL): Uint8Array }>;
const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs' as string);

async function fonts() {
  const fs = await nodeFs();
  return {
    regular: fs.readFileSync(new URL('./fonts/Alef-Regular.ttf', import.meta.url)),
    bold: fs.readFileSync(new URL('./fonts/Alef-Bold.ttf', import.meta.url)),
  };
}

/** A real 2×1 RGBA PNG (one dark pixel, one transparent) built with node:zlib. */
async function tinyPng(): Promise<string> {
  const zlib = (await import('node:zlib' as string)) as { deflateSync(b: Uint8Array): Uint8Array };
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: Uint8Array) => {
    const td = new Uint8Array([...type].map((c) => c.charCodeAt(0)).concat([...data]));
    return [...be(data.length), ...td, ...be(crc(td))];
  };
  const ihdr = new Uint8Array([...be(2), ...be(1), 8, 6, 0, 0, 0]);
  const raw = new Uint8Array([0, 20, 20, 30, 255, 0, 0, 0, 0]);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr), ...chunk('IDAT', zlib.deflateSync(raw)), ...chunk('IEND', new Uint8Array())]);
  let bin = '';
  for (const x of png) bin += String.fromCharCode(x);
  return `data:image/png;base64,${btoa(bin)}`;
}

describe('export: document edits (edit text, signature)', () => {
  it('draws the paper cover + replacement text and embeds the signature image', async () => {
    const src = await PDFDocument.create();
    const p = src.addPage([600, 400]);
    p.drawText('SOUTH ELEVATION', { x: 100, y: 300, size: 12 });
    const bytes = await src.save();
    const image = await tinyPng();
    const edit: AreaMeasurement = {
      id: 'e1',
      page: 1,
      kind: 'textEdit',
      label: 'עריכת טקסט 1',
      color: '#000000',
      points: [{ x: 98, y: 86 }, { x: 210, y: 104 }],
      text: 'NORTH ELEVATION',
      origText: 'SOUTH ELEVATION',
      fontSize: 12,
    };
    const heb: AreaMeasurement = {
      id: 'e2',
      page: 1,
      kind: 'textEdit',
      label: 'עריכת טקסט 2',
      color: '#000000',
      points: [{ x: 300, y: 86 }, { x: 380, y: 104 }],
      text: 'חזית צפונית',
      origText: 'חזית דרומית',
      fontSize: 12,
      rtl: true,
    };
    const sig: AreaMeasurement = {
      id: 's1',
      page: 1,
      kind: 'signature',
      label: 'חתימה 1',
      color: '#111827',
      points: [{ x: 400, y: 300 }, { x: 520, y: 360 }],
      image,
      aspect: 2,
      text: '09.11.2026',
    };
    const input: PdfBuildInput = {
      docs: [{ id: 'doc1', name: 'x.pdf' }],
      bytes: { doc1: bytes },
      pages: [{ globalPage: 1, docId: 'doc1', localPage: 1 }],
      pageSizes: { 1: { width: 600, height: 400 } },
      measurements: [edit, heb, sig],
      calibrations: {},
      categories: DEFAULT_CATEGORIES,
      // Document edits are drawn even with the markup layer off.
      options: { ...DEFAULT_PDF_OPTIONS, markup: false, items: false, summary: false },
      fonts: await fonts(),
      title: 'x',
    };
    const out = await buildExportPdf(input);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    // An image XObject on the page.
    const res = doc.getPage(0).node.Resources()!;
    const xo = res.lookup(PDFName.of('XObject'), PDFDict);
    const subtypes = xo.keys().map((k) => (xo.lookup(k) as unknown as { dict: PDFDict }).dict.get(PDFName.of('Subtype'))?.toString());
    expect(subtypes).toContain('/Image');

    const pd = await (await pdfjs()).getDocument({ data: out }).promise;
    const page = await pd.getPage(1);
    const text = (await page.getTextContent()).items.map((i: { str: string }) => i.str).join('|');
    expect(text).toContain('SOUTH ELEVATION'); // the original stays in the file (covered, not removed)
    expect(text).toContain('NORTH ELEVATION');
    expect(text).toContain('09.11.2026');
    const plain = text.replace(/\s|\|/g, '');
    expect(plain.includes('חזיתצפונית') || plain.includes([...'חזיתצפונית'].reverse().join(''))).toBe(true);
    // White fill (the cover) and an image paint in the operator list.
    const { OPS } = await pdfjs();
    const ops = await page.getOperatorList();
    const fills = ops.fnArray
      .map((fn: number, i: number) => (fn === OPS.setFillRGBColor ? String(ops.argsArray[i]) : null))
      .filter(Boolean);
    expect(fills.some((f: string) => /^#ffffff$|^255,255,255$|^1,1,1$/i.test(f))).toBe(true);
    expect(ops.fnArray).toContain(OPS.paintImageXObject);
    await pd.destroy();
  });

  it('document edits never reach the quantities / CSV', () => {
    const ms: AreaMeasurement[] = [
      { id: 'e1', page: 1, kind: 'textEdit', label: 'עריכת טקסט 1', color: '#000', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], text: 'X' },
      { id: 's1', page: 1, kind: 'signature', label: 'חתימה 1', color: '#000', points: [{ x: 0, y: 0 }, { x: 10, y: 5 }], image: 'data:image/png;base64,AA==', aspect: 2 },
    ];
    const csv = buildExportCsv(ms, {}, DEFAULT_CATEGORIES, [1], DEFAULT_CSV_OPTIONS);
    expect(csv).not.toContain('עריכת טקסט 1');
    expect(csv).not.toContain('חתימה 1');
  });
});
