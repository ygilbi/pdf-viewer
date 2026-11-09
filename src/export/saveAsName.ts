/**
 * "שמור בשם" (Save As) — pure helpers (no DOM, no stores): the suggested file name and the PDF
 * content options. The PDF itself is built by the export pipeline (runExport → buildPdf).
 */
import { DEFAULT_PDF_OPTIONS, type PdfContentOptions } from './types';

export const SAVE_AS_SUFFIX = '-marked';

/** Characters Windows / macOS refuse in file names (+ control characters). */
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]+/g;

/**
 * `<original>-marked.pdf` for the first open file (the workspace is saved as one PDF in tab order).
 * Strips folders and the .pdf extension, replaces characters no file system accepts, never empty,
 * and does not stack "-marked" when the file already is a saved copy.
 */
export function suggestSaveAsName(names: readonly (string | null | undefined)[]): string {
  const first = names.find((n) => typeof n === 'string' && n.trim()) ?? '';
  let base = first.split(/[\\/]/).pop() ?? '';
  base = base.replace(/\.pdf$/i, '').replace(BAD_CHARS, '_').replace(/[. ]+$/, '').trim();
  if (!base) base = 'document';
  if (!base.toLowerCase().endsWith(SAVE_AS_SUFFIX)) base += SAVE_AS_SUFFIX;
  return `${base}.pdf`;
}

/** The name the user typed in a save dialog, with a .pdf extension (Electron's dialog does not add one). */
export function ensurePdfExtension(name: string): string {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

/**
 * Same content as the export dialog's PDF defaults (drawings, measurements, markup incl. text
 * edits / signatures, calibration line, items table). The items table page is left out when the
 * workspace has no items — otherwise a plain "save a marked copy" would end with an
 * "אין פריטים" page.
 */
export function saveAsPdfOptions(hasItems: boolean): PdfContentOptions {
  return { ...DEFAULT_PDF_OPTIONS, items: DEFAULT_PDF_OPTIONS.items && hasItems };
}

/** All global page numbers 1..numPages. */
export function allPages(numPages: number): number[] {
  return Array.from({ length: Math.max(0, Math.floor(numPages)) }, (_, i) => i + 1);
}
