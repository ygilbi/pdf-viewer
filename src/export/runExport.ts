/**
 * Export orchestration (main thread): collects the selection, original file
 * bytes and fonts, builds the file (PDF in a Web Worker with a main-thread
 * fallback; CSV inline) and saves it — via the File System Access save
 * picker when available and allowed, else a Blob download.
 */
import regularFontUrl from './fonts/Alef-Regular.ttf?url';
import boldFontUrl from './fonts/Alef-Bold.ttf?url';
import { useViewer } from '../state/store';
import { downloadBlob } from '../components/ui/util';
import { buildExportCsv } from './csvExport';
import { docBytes, pageSizeMap, pageSpecs } from './sources';
import type { CsvOptions, ExportFormat, PdfBuildInput, PdfContentOptions, ProgressStage } from './types';
import { buildMeasurementRows, categoryKey, categoryName, kindOf, takeoffOnly, KIND_LABELS } from '../core/measurementEngine';
import { buildItemTable } from '../core/itemTable';

const MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export interface ExportRequest {
  format: ExportFormat;
  /** Global page numbers. */
  pages: number[];
  pdf: PdfContentOptions;
  csv: CsvOptions;
  /** File name (extension added when missing). */
  fileName: string;
  /** Ask where to save (showSaveFilePicker) when the browser supports it. */
  usePicker: boolean;
}

export type ExportResult = { how: 'picker' | 'download'; fileName: string; bytes: number; ms: number };

export interface ExportHandle {
  promise: Promise<ExportResult>;
  cancel(): void;
}

export class ExportAbort extends Error {
  constructor() {
    super('הייצוא בוטל');
    this.name = 'AbortError';
  }
}

const STAGE_TEXT: Record<ProgressStage, string> = {
  load: 'טוען קבצים',
  pages: 'מעתיק דפים ומצייר מדידות',
  summary: 'יוצר טבלאות סיכום',
  save: 'שומר קובץ',
};
const STAGE_RANGE: Record<ProgressStage, [number, number]> = {
  load: [0.02, 0.12],
  pages: [0.12, 0.85],
  summary: [0.85, 0.9],
  save: [0.9, 1],
};

export type ProgressCb = (fraction: number, text: string) => void;

export const savePickerSupported = () =>
  typeof window !== 'undefined' && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';

/** Safe file name with the right extension. */
export function exportFileName(name: string, format: ExportFormat): string {
  const ext = `.${format}`;
  let base = (name || 'export').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  base = base.replace(/\.(pdf|csv|xlsx)$/i, '');
  return (base || 'export') + ext;
}

let fontCache: Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }> | null = null;
function loadFonts() {
  const get = (u: string) =>
    fetch(u).then((r) => {
      if (!r.ok) throw new Error(`טעינת הגופן נכשלה (${r.status})`);
      return r.arrayBuffer();
    });
  fontCache ??= Promise.all([get(regularFontUrl), get(boldFontUrl)]).then(([regular, bold]) => ({ regular, bold }));
  fontCache.catch(() => (fontCache = null));
  return fontCache;
}

type FileHandle = { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> };

async function pickTarget(req: ExportRequest, fileName: string): Promise<FileHandle | null> {
  if (!req.usePicker || !savePickerSupported()) return null;
  const mime = MIME[req.format];
  try {
    return await (window as unknown as { showSaveFilePicker(o: unknown): Promise<FileHandle> }).showSaveFilePicker({
      suggestedName: fileName,
      types: [{ description: req.format === 'xlsx' ? 'Excel' : req.format.toUpperCase(), accept: { [mime]: [`.${req.format}`] } }],
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new ExportAbort(); // user closed the picker
    return null; // SecurityError (iframe / no activation) etc. → plain download
  }
}

function buildInWorker(input: PdfBuildInput, transfer: ArrayBuffer[], onStage: (s: ProgressStage, d: number, t: number) => void, signal: { cancelled: boolean; onCancel?: () => void }) {
  return new Promise<Uint8Array>((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module', name: 'pdf-export' });
    } catch (e) {
      reject(Object.assign(new Error('worker unavailable'), { workerUnavailable: true, cause: e }));
      return;
    }
    let started = false;
    signal.onCancel = () => {
      w.terminate();
      reject(new ExportAbort());
    };
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      started = true;
      if (m.type === 'progress') onStage(m.stage, m.done, m.total);
      else if (m.type === 'done') {
        w.terminate();
        resolve(m.bytes as Uint8Array);
      } else if (m.type === 'error') {
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.onerror = (ev) => {
      ev.preventDefault?.();
      w.terminate();
      // A worker that never ran (module workers unsupported, CSP) → main-thread fallback.
      reject(Object.assign(new Error(ev.message || 'export worker failed'), { workerUnavailable: !started }));
    };
    w.postMessage({ type: 'build', input }, transfer);
  });
}

export function startExport(req: ExportRequest, onProgress: ProgressCb = () => {}): ExportHandle {
  const signal: { cancelled: boolean; onCancel?: () => void } = { cancelled: false };
  const t0 = performance.now();
  const fileName = exportFileName(req.fileName, req.format);
  // Ask for the target first: the picker needs the click's user activation.
  const targetP = pickTarget(req, fileName);

  const run = async (): Promise<ExportResult> => {
    const target = await targetP;
    const check = () => {
      if (signal.cancelled) throw new ExportAbort();
    };
    const s = useViewer.getState();
    const docs = s.docs;
    const pages = pageSpecs(docs, req.pages);
    if (!pages.length) throw new Error('לא נבחרו דפים לייצוא');
    let blob: Blob;
    if (req.format === 'csv') {
      onProgress(0.5, 'יוצר CSV');
      const csv = buildExportCsv(s.measurements, s.calibrations, s.categories, req.pages, req.csv);
      blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    } else if (req.format === 'xlsx') {
      onProgress(0.2, 'טוען רכיב Excel');
      const { buildXlsx } = await import('./xlsxExport');
      check();
      onProgress(0.5, 'יוצר גיליון Excel');
      const pageSet = new Set(req.pages);
      const onPages = s.measurements.filter((m) => pageSet.has(m.page));
      const notes = onPages
        .filter((m) => (m.kind === 'note' || m.kind === 'text') && (m.text ?? '').trim())
        .map((m, i) => {
          const k = categoryKey(m);
          return [String(i + 1), KIND_LABELS[kindOf(m)], m.label, k ? categoryName(k, s.categories) : '', String(m.page), (m.text ?? '').trim()];
        });
      const out = await buildXlsx({
        items: buildItemTable(onPages, s.calibrations, s.categories),
        measurementRows: buildMeasurementRows(takeoffOnly(onPages), s.calibrations, s.categories),
        notes,
        title: fileName.replace(/\.xlsx$/i, ''),
        dateText: new Date().toLocaleDateString('he-IL'),
        files: [...new Set(pages.map((p) => docs.find((d) => d.id === p.docId)?.name ?? p.docId))],
      });
      blob = new Blob([out as BlobPart], { type: MIME.xlsx });
    } else {
      onProgress(0.01, 'טוען גופנים וקבצים');
      const usedDocs = docs.filter((d) => pages.some((p) => p.docId === d.id));
      const [fonts, ...buffers] = await Promise.all([
        loadFonts(),
        ...(req.pdf.drawings ? usedDocs.map((d) => docBytes(d.id)) : []),
      ]);
      check();
      const bytes: Record<string, ArrayBuffer> = {};
      if (req.pdf.drawings) usedDocs.forEach((d, i) => (bytes[d.id] = buffers[i] as ArrayBuffer));
      const input: PdfBuildInput = {
        docs: docs.map((d) => ({ id: d.id, name: d.name })),
        bytes,
        pages,
        pageSizes: pageSizeMap(s.pageSizes, pages),
        measurements: s.measurements,
        calibrations: s.calibrations,
        categories: s.categories,
        options: req.pdf,
        fonts,
        title: fileName.replace(/\.pdf$/i, ''),
        dateText: new Date().toLocaleDateString('he-IL'),
      };
      const onStage = (stage: ProgressStage, done: number, total: number) => {
        const [a, b] = STAGE_RANGE[stage];
        const frac = a + (b - a) * (total > 0 ? Math.min(1, done / total) : 0);
        const detail = stage === 'pages' ? ` (${Math.min(pages.length, Math.round(done))}/${pages.length})` : '';
        onProgress(frac, STAGE_TEXT[stage] + detail);
      };
      let out: Uint8Array;
      try {
        out = await buildInWorker(input, Object.values(bytes), onStage, signal);
      } catch (e) {
        if (!(e as { workerUnavailable?: boolean }).workerUnavailable) throw e;
        console.warn('[export] worker unavailable, building on the main thread', e);
        // The buffers were not transferred (worker never started) → still usable.
        const { buildExportPdf } = await import('./buildPdf');
        out = await buildExportPdf(input, onStage, () => signal.cancelled);
      }
      check();
      blob = new Blob([out as BlobPart], { type: 'application/pdf' });
    }
    check();
    let how: ExportResult['how'] = 'download';
    if (target) {
      try {
        const wr = await target.createWritable();
        await wr.write(blob);
        await wr.close();
        how = 'picker';
      } catch (e) {
        console.warn('[export] writing via save picker failed, downloading instead', e);
        downloadBlob(blob, fileName);
      }
    } else downloadBlob(blob, fileName);
    const ms = Math.round(performance.now() - t0);
    console.info(`[export] ${req.format} ${pages.length} pages, ${blob.size} bytes in ${ms} ms`);
    onProgress(1, 'הסתיים');
    return { how, fileName, bytes: blob.size, ms };
  };

  return {
    promise: run(),
    cancel: () => {
      if (signal.cancelled) return;
      signal.cancelled = true;
      signal.onCancel?.();
    },
  };
}
