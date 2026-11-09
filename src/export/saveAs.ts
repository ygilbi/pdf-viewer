/**
 * "שמור בשם" (Save As, Ctrl+Shift+S): saves the whole workspace as ONE PDF with every marking
 * embedded (the export pipeline with the export dialog's PDF defaults — runExport → buildPdf),
 * under a name the user picks:
 * - desktop app (Electron): native Save dialog via IPC (window.pdfDesktop.saveAsChoose / saveAsWrite);
 * - browsers with the File System Access API: showSaveFilePicker;
 * - elsewhere (Safari / iPhone, Firefox): a download with the suggested name.
 *
 * Kept light (the always-visible top bar imports it): the export pipeline is a dynamic import.
 */
import { create } from 'zustand';
import { useViewer } from '../state/store';
import { getDesktop } from '../desktop/bridge';
import { downloadBlob } from '../components/ui/util';
import { DEFAULT_CSV_OPTIONS } from './types';
import { allPages, saveAsPdfOptions, suggestSaveAsName } from './saveAsName';
import type { ExportHandle } from './runExport';

export type SaveAsStatus =
  | { phase: 'running'; frac: number; text: string; name: string }
  | { phase: 'done'; name: string; how: 'desktop' | 'picker' | 'download'; bytes: number }
  | { phase: 'error'; text: string };

export const useSaveAs = create<{ status: SaveAsStatus | null }>(() => ({ status: null }));

let current: ExportHandle | null = null;
let seq = 0;

export const dismissSaveAs = () => {
  if (useSaveAs.getState().status?.phase !== 'running') useSaveAs.setState({ status: null });
};

export function cancelSaveAs(): void {
  current?.cancel();
}

type FileHandle = { name?: string; createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> };
type PickerWindow = { showSaveFilePicker?(o: unknown): Promise<FileHandle> };

const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Starts a Save As. Call it straight from the click / key handler: the browser's save picker needs
 * that user activation, so it is opened before anything is awaited.
 */
export function saveAsMarked(): void {
  const v = useViewer.getState();
  if (!v.docs.length || !v.numPages) return;
  if (useSaveAs.getState().status?.phase === 'running') return;
  const suggested = suggestSaveAsName(v.docs.map((d) => d.name));
  const my = ++seq;

  const desktop = getDesktop();
  const picker = (window as unknown as PickerWindow).showSaveFilePicker;
  type Target = { kind: 'desktop'; token: string; name: string } | { kind: 'picker'; handle: FileHandle; name: string } | { kind: 'download'; name: string };

  // 1) where to save (synchronously started: keeps the click's user activation for the picker)
  let targetP: Promise<Target | null>;
  if (desktop?.saveAsChoose && desktop.saveAsWrite) {
    targetP = desktop.saveAsChoose(suggested).then((t): Target | null => (t ? { kind: 'desktop', token: t.token, name: t.name } : null));
  } else if (typeof picker === 'function') {
    targetP = picker
      .call(window, {
        suggestedName: suggested,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      })
      .then(
        (handle): Target => ({ kind: 'picker', handle, name: handle.name || suggested }),
        (e): Target | null => {
          if (isAbort(e)) return null; // the user closed the picker
          console.warn('[save-as] save picker unavailable, downloading instead', e);
          return { kind: 'download', name: suggested };
        },
      );
  } else {
    targetP = Promise.resolve({ kind: 'download', name: suggested });
  }

  void (async () => {
    let target: Target | null;
    try {
      target = await targetP;
    } catch (e) {
      useSaveAs.setState({ status: { phase: 'error', text: `השמירה נכשלה: ${errText(e)}` } });
      return;
    }
    if (!target || my !== seq) return;
    const name = target.name;
    useSaveAs.setState({ status: { phase: 'running', frac: 0, text: 'מתחיל…', name } });
    try {
      // 2) build the PDF with the export pipeline (temp / view-mode checks are filtered there)
      const [{ startExport }, { isMarkupKind }, { isItem }, { persistentMeasurements }] = await Promise.all([
        import('./runExport'),
        import('../core/measurementEngine'),
        import('../core/itemTable'),
        import('../core/tempMeasurements'),
      ]);
      const s = useViewer.getState();
      const hasItems = persistentMeasurements(s.measurements).some((m) => !isMarkupKind(m.kind) && isItem(m));
      const h = startExport(
        {
          format: 'pdf',
          pages: allPages(s.numPages),
          pdf: saveAsPdfOptions(hasItems),
          csv: DEFAULT_CSV_OPTIONS,
          fileName: name,
          usePicker: false,
          deliver: false,
        },
        (frac, text) => {
          if (my === seq) useSaveAs.setState({ status: { phase: 'running', frac, text, name } });
        },
      );
      current = h;
      const r = await h.promise;
      // 3) write it
      let how: 'desktop' | 'picker' | 'download' = target.kind;
      if (target.kind === 'desktop') {
        await getDesktop()!.saveAsWrite!(target.token, await r.blob.arrayBuffer());
      } else if (target.kind === 'picker') {
        try {
          const wr = await target.handle.createWritable();
          await wr.write(r.blob);
          await wr.close();
        } catch (e) {
          console.warn('[save-as] writing via the save picker failed, downloading instead', e);
          downloadBlob(r.blob, name);
          how = 'download';
        }
      } else downloadBlob(r.blob, name);
      if (my === seq) useSaveAs.setState({ status: { phase: 'done', name, how, bytes: r.bytes } });
    } catch (e) {
      if (my !== seq) return;
      useSaveAs.setState({ status: isAbort(e) ? null : { phase: 'error', text: `השמירה נכשלה: ${errText(e)}` } });
    } finally {
      if (my === seq) current = null;
    }
  })();
}
