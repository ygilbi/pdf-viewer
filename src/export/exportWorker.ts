/// <reference lib="webworker" />
/**
 * Export worker: assembles the PDF with pdf-lib off the main thread (copying
 * dozens of heavy vector pages and saving can take seconds). Cancel = the
 * main thread terminates the worker.
 *
 * in:  { type: 'build', input: PdfBuildInput }
 * out: { type: 'progress', stage, done, total } | { type: 'done', bytes } | { type: 'error', message }
 */
import { buildExportPdf } from './buildPdf';
import type { PdfBuildInput } from './types';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (ev: MessageEvent<{ type: 'build'; input: PdfBuildInput }>) => {
  if (ev.data?.type !== 'build') return;
  try {
    const bytes = await buildExportPdf(ev.data.input, (stage, done, total) =>
      self.postMessage({ type: 'progress', stage, done, total }),
    );
    self.postMessage({ type: 'done', bytes }, [bytes.buffer]);
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
