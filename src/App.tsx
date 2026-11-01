import { useCallback, useEffect, useRef, useState } from 'react';
import { useViewer } from './state/store';
import { getPdfClient } from './core/pdfClient';
import { ErrorToast, ViewerShell } from './components/shell/ViewerShell';
import DropZone from './components/DropZone';
import ViewerCanvas from './components/ViewerCanvas';
import { IconFilePdf } from './components/ui/icons';
import { formatBytes } from './components/ui/util';
import { RestoreToast, detachDocument, fingerprintFile, restoreDocument, usePersistence } from './state/persistence';
import { useFileLaunch } from './pwa/fileHandling';

function isPdf(file: File) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/** Hebrew wording for the common open() failures; falls back to the raw message. */
function describeOpenError(msg: string): string {
  if (/password|encrypt/i.test(msg)) return 'הקובץ מוגן בסיסמה — קבצים מוגנים אינם נתמכים';
  if (/not a valid pdf|corrupt|invalid pdf|missing pdf/i.test(msg)) return 'הקובץ אינו PDF תקין או שהוא פגום';
  return msg;
}

function hasFiles(e: DragEvent) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

export default function App() {
  const numPages = useViewer((s) => s.numPages);
  const fileName = useViewer((s) => s.fileName);
  const loading = useViewer((s) => s.loading);

  const [pending, setPending] = useState<{ name: string; size: number } | null>(null);
  const openSeq = useRef(0);
  usePersistence();

  const openFile = useCallback(async (file: File) => {
    const s = useViewer.getState();
    if (!isPdf(file)) {
      s.setError(`הקובץ "${file.name}" אינו קובץ PDF`);
      return;
    }
    // No confirm: measurements are auto-saved per file and restored on reopen.
    const seq = ++openSeq.current;
    const fingerprint = fingerprintFile(file); // hashes 2×256KB slices, in parallel with open()
    s.setError(null);
    s.setLoading(true);
    setPending({ name: file.name, size: file.size });
    try {
      const info = await getPdfClient().open(file);
      if (seq !== openSeq.current) return;
      if (!info.numPages) throw new Error('המסמך אינו מכיל דפים');
      detachDocument(); // flush + stop saving the previous file before the store is reset
      useViewer.getState().setDocument({ fileName: file.name, numPages: info.numPages, pageSizes: info.pageSizes });
      const fp = await fingerprint;
      if (seq !== openSeq.current) return;
      await restoreDocument(fp, file.name);
    } catch (err) {
      if (seq !== openSeq.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      useViewer.getState().setError(`שגיאה בפתיחת הקובץ ${file.name}: ${describeOpenError(msg)}`);
    } finally {
      if (seq === openSeq.current) {
        useViewer.getState().setLoading(false);
        setPending(null);
      }
    }
  }, []);
  useFileLaunch(openFile); // PWA: open PDFs launched via "Open with" / default app

  // Window-wide drag & drop (replace the document at any time).
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) void openFile(f);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [openFile]);

  const hasDoc = numPages > 0;

  return (
    // Full-window shell: once a document is open the viewer covers 100% of the
    // window and every other control floats over it (pill, palette, drawers, menu).
    <div className="fixed inset-0 overflow-hidden bg-slate-900 text-slate-100 antialiased">
      {hasDoc ? (
        <>
          <main
            className="absolute inset-0 overflow-hidden bg-slate-950"
            aria-label={fileName ?? undefined}
            data-testid="viewer-main"
          >
            <ViewerCanvas />
          </main>
          <ViewerShell onOpenFile={openFile} />
        </>
      ) : (
        <main className="absolute inset-0">{!loading && <DropZone onFile={openFile} />}</main>
      )}

      <ErrorToast />

      {loading && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
          <div className="flex min-w-[18rem] flex-col items-center gap-3 rounded-lg border border-slate-700 bg-slate-800 px-8 py-6 shadow-2xl">
            <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-slate-600 border-t-sky-400" />
            <div className="text-sm font-semibold">טוען מסמך…</div>
            {pending && (
              <div className="flex max-w-xs items-center gap-1.5 text-xs text-slate-400">
                <IconFilePdf size={14} className="shrink-0 text-red-400" />
                <span className="truncate" dir="auto">
                  {pending.name}
                </span>
                <span className="shrink-0 font-mono" dir="ltr">
                  ({formatBytes(pending.size)})
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <RestoreToast />

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-4 border-dashed border-sky-400 bg-sky-950/60">
          <div className="rounded-lg bg-slate-900/90 px-6 py-4 text-lg font-semibold text-sky-200 shadow-xl">
            שחרר כדי לפתוח את קובץ ה‑PDF
          </div>
        </div>
      )}
    </div>
  );
}
