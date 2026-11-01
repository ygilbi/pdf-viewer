import { useCallback, useEffect, useRef, useState } from 'react';
import { useViewer } from './state/store';
import { getPdfClient } from './core/pdfClient';
import MeasurementToolbar from './components/MeasurementToolbar';
import ThumbnailSidebar from './components/ThumbnailSidebar';
import MeasurementsPanel from './components/MeasurementsPanel';
import DropZone from './components/DropZone';
import ViewerCanvas from './components/ViewerCanvas';
import { IconAlert, IconFilePdf, IconX } from './components/ui/icons';
import { formatBytes } from './components/ui/util';

function isPdf(file: File) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function hasFiles(e: DragEvent) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

export default function App() {
  const numPages = useViewer((s) => s.numPages);
  const fileName = useViewer((s) => s.fileName);
  const loading = useViewer((s) => s.loading);
  const error = useViewer((s) => s.error);
  const setError = useViewer((s) => s.setError);

  const [pending, setPending] = useState<{ name: string; size: number } | null>(null);
  const openSeq = useRef(0);

  const openFile = useCallback(async (file: File) => {
    const s = useViewer.getState();
    if (!isPdf(file)) {
      s.setError(`הקובץ "${file.name}" אינו קובץ PDF`);
      return;
    }
    if (s.measurements.length > 0 && !window.confirm('פתיחת קובץ חדש תמחק את המדידות הקיימות. להמשיך?')) return;
    const seq = ++openSeq.current;
    s.setError(null);
    s.setLoading(true);
    setPending({ name: file.name, size: file.size });
    try {
      const info = await getPdfClient().open(file);
      if (seq !== openSeq.current) return;
      if (!info.numPages) throw new Error('המסמך אינו מכיל דפים');
      useViewer.getState().setDocument({ fileName: file.name, numPages: info.numPages, pageSizes: info.pageSizes });
    } catch (err) {
      if (seq !== openSeq.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      useViewer.getState().setError(`שגיאה בפתיחת הקובץ "${file.name}": ${msg}`);
    } finally {
      if (seq === openSeq.current) {
        useViewer.getState().setLoading(false);
        setPending(null);
      }
    }
  }, []);

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
    <div className="relative flex h-full flex-col bg-slate-900 text-slate-100 antialiased">
      <MeasurementToolbar onOpenFile={openFile} />

      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-red-800 bg-red-950/80 px-3 py-1.5 text-sm text-red-200"
        >
          <IconAlert className="shrink-0 text-red-400" />
          <span className="flex-1" dir="auto">
            {error}
          </span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="סגור הודעה"
            className="rounded p-0.5 text-red-300 hover:bg-red-900 hover:text-white"
          >
            <IconX size={14} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {hasDoc ? (
          <>
            {/* RTL: first child sits on the right */}
            <ThumbnailSidebar />
            <main className="relative min-w-0 flex-1 overflow-hidden bg-slate-950" aria-label={fileName ?? undefined}>
              <ViewerCanvas />
            </main>
            <MeasurementsPanel />
          </>
        ) : (
          <main className="relative flex-1">{!loading && <DropZone onFile={openFile} />}</main>
        )}
      </div>

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
