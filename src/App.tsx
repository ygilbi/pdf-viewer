import { useCallback, useEffect, useRef, useState } from 'react';
import { useViewer } from './state/store';
import { getPdfClient } from './core/pdfClient';
import { ErrorToast, ViewerShell } from './components/shell/ViewerShell';
import DropZone from './components/DropZone';
import ViewerCanvas from './components/ViewerCanvas';
import { IconFilePdf } from './components/ui/icons';
import { formatBytes } from './components/ui/util';
import { RestoreToast, detachDoc, detachDocument, fingerprintFile, restoreDocument, usePersistence } from './state/persistence';
import { useFileLaunch } from './pwa/fileHandling';
import { DefaultAppPrompt } from './pwa/DefaultAppPrompt';
import { UpdateToast } from './pwa/UpdateToast';
import { useFileQueue } from './state/fileQueue';
import { useDesktopFileOpen } from './desktop/bridge';
import { useAuthGate } from './auth/session';
import { AuthSplash } from './auth/AuthSplash';
import { DriveOverlay, useDriveLaunch } from './drive/DriveUi';
import { FileTabBar, TABBAR_H } from './components/shell/FileTabBar';
import { CrashReportCard } from './diag/CrashReportCard';

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

/** Auth gate (web): splash while GET /api/auth/me runs; signed-out visitors are sent to /login. */
export default function App() {
  const ready = useAuthGate();
  return ready ? <Workspace /> : <AuthSplash />;
}

function Workspace() {
  const numPages = useViewer((s) => s.numPages);
  const fileName = useViewer((s) => s.fileName);
  const loading = useViewer((s) => s.loading);

  const [pending, setPending] = useState<{ name: string; size: number } | null>(null);
  const openSeq = useRef(0);
  usePersistence();

  /** Replace the whole workspace with `file`. */
  const openFileImpl = useCallback(async (file: File) => {
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
      const client = getPdfClient();
      const info = await client.open(file);
      if (seq !== openSeq.current) return;
      if (!info.numPages) throw new Error('המסמך אינו מכיל דפים');
      const docId = client.docs()[0]?.id;
      detachDocument(); // flush + stop saving the previous file(s) before the store is reset
      useViewer.getState().setDocument({ fileName: file.name, numPages: info.numPages, pageSizes: info.pageSizes, docId });
      const fp = await fingerprint;
      if (seq !== openSeq.current) return;
      if (docId) useViewer.getState().updateDocument(docId, { fingerprint: fp });
      await restoreDocument(fp, file.name, docId);
    } catch (err) {
      if (seq !== openSeq.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      useViewer.getState().setError(`שגיאה בפתיחת הקובץ ${file.name}: ${describeOpenError(msg)}`);
    } finally {
      if (seq === openSeq.current) {
        useViewer.getState().setLoading(false);
        setPending(null);
      }
    }
  }, []);
  // Adding files: processed one at a time, in order, so global page order = add order.
  const addChain = useRef<Promise<void>>(Promise.resolve());
  /** Menu "open (replace)": drops queued adds, aborts a running one (client.open closes all), later adds wait for it. */
  const openFile = useCallback(
    (file: File) => {
      useFileQueue.setState({ items: [] });
      const p = openFileImpl(file);
      addChain.current = p;
      return p;
    },
    [openFileImpl],
  );
  const queueKey = useRef(0);
  const addFiles = useCallback(
    (files: File[]) => {
      const pdfs = files.filter(isPdf);
      const rejected = files.filter((f) => !isPdf(f));
      if (rejected.length) useViewer.getState().setError(`הקובץ "${rejected[0].name}" אינו קובץ PDF`);
      if (!pdfs.length) return;
      const st = useViewer.getState();
      let rest = pdfs;
      if (st.docs.length === 0 && !st.loading && useFileQueue.getState().items.length === 0) {
        // Nothing open: open the first one (full loading screen), then add the rest.
        const first = pdfs[0];
        rest = pdfs.slice(1);
        addChain.current = addChain.current.then(() => openFileImpl(first));
      }
      const q = useFileQueue.getState();
      const keys = rest.map(() => ++queueKey.current);
      useFileQueue.setState({
        items: [...q.items, ...rest.map((f, i) => ({ key: keys[i], name: f.name, size: f.size, status: 'waiting' as const }))],
      });
      const patch = (key: number, p: Partial<(typeof q.items)[number]> | null) =>
        useFileQueue.setState((s) => ({
          items: p ? s.items.map((i) => (i.key === key ? { ...i, ...p } : i)) : s.items.filter((i) => i.key !== key),
        }));
      rest.forEach((file, i) => {
        const key = keys[i];
        addChain.current = addChain.current.then(async () => {
          if (!useFileQueue.getState().items.some((it) => it.key === key)) return; // workspace replaced meanwhile
          if (useViewer.getState().docs.length === 0) return patch(key, null); // the first file failed to open
          const mySeq = openSeq.current;
          patch(key, { status: 'loading' });
          const fingerprint = fingerprintFile(file);
          try {
            const doc = await getPdfClient().addFile(file);
            if (mySeq !== openSeq.current) return patch(key, null);
            if (!doc.numPages) throw new Error('המסמך אינו מכיל דפים');
            useViewer.getState().addDocument(doc);
            patch(key, null);
            const fp = await fingerprint;
            if (mySeq !== openSeq.current) return;
            useViewer.getState().updateDocument(doc.id, { fingerprint: fp });
            await restoreDocument(fp, file.name, doc.id);
          } catch (err) {
            if (mySeq !== openSeq.current || (err as { name?: string })?.name === 'AbortError') return patch(key, null);
            const msg = describeOpenError(err instanceof Error ? err.message : String(err));
            patch(key, { status: 'error', error: msg });
            useViewer.getState().setError(`שגיאה בהוספת הקובץ ${file.name}: ${msg}`);
          }
        });
      });
    },
    [openFileImpl],
  );

  const removeDoc = useCallback((docId: string) => {
    detachDoc(docId); // flush its pending save while its measurements are still in the store
    useViewer.getState().removeDocument(docId);
    void getPdfClient().removeDoc(docId);
  }, []);

  useEffect(() => {
    useFileQueue.setState({ addFiles, removeDoc });
  }, [addFiles, removeDoc]);

  // PWA: PDFs launched via "Open with" / default app — added to an open workspace.
  useFileLaunch(addFiles);
  // Windows desktop app (Electron): PDFs double-clicked in Explorer / passed on the command line.
  useDesktopFileOpen(addFiles);
  // Google Drive "Open with → PDF Viewer" (/drive/open?state=…): downloaded in the browser, then opened like a local file.
  useDriveLaunch(addFiles);

  // Window-wide drag & drop: adds the dropped PDFs to the workspace (opens them when empty).
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
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) addFiles(files);
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
  }, [addFiles]);

  const hasDoc = numPages > 0;

  return (
    // Full-window shell: once a document is open the viewer covers 100% of the
    // window and every other control floats over it (pill, palette, drawers, menu).
    // touch-action pan-x pan-y: panels still scroll, but the browser never pinch-zooms the whole page on top of
    // the viewer's own zoom (iOS Safari ignores user-scalable=no; a doubled zoom can exhaust its memory).
    <div className="fixed inset-0 overflow-hidden bg-slate-900 text-slate-100 antialiased" style={{ touchAction: 'pan-x pan-y' }} data-lock-scroll>
      {hasDoc ? (
        <>
          {/* File tabs on top; the viewer and all its floating chrome live in the region below. */}
          <FileTabBar />
          <div className="absolute inset-x-0 bottom-0" style={{ top: TABBAR_H }} data-testid="viewer-region" data-lock-scroll>
            <main
              className="absolute inset-0 overflow-hidden bg-slate-950" data-lock-scroll
              aria-label={fileName ?? undefined}
              data-testid="viewer-main"
            >
              <ViewerCanvas />
            </main>
            <ViewerShell onOpenFile={openFile} />
          </div>
        </>
      ) : (
        <main className="absolute inset-0">{!loading && <DropZone onFiles={addFiles} />}</main>
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

      <DriveOverlay />
      <RestoreToast />
      <DefaultAppPrompt />
      <UpdateToast />
      <CrashReportCard />
      {hasDoc && <AddProgress />}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-4 border-dashed border-sky-400 bg-sky-950/60">
          <div className="rounded-lg bg-slate-900/90 px-6 py-4 text-lg font-semibold text-sky-200 shadow-xl">
            {hasDoc ? 'שחרר כדי להוסיף את קובצי ה‑PDF' : 'שחרר כדי לפתוח את קובץ ה‑PDF'}
          </div>
        </div>
      )}
    </div>
  );
}

/** Floating per-file progress while files are being added to an open workspace. */
function AddProgress() {
  const items = useFileQueue((s) => s.items);
  const dismiss = useFileQueue((s) => s.dismiss);
  if (!items.length) return null;
  return (
    <div
      role="status"
      data-testid="add-progress"
      className="pointer-events-auto absolute bottom-4 right-4 z-30 flex w-72 flex-col gap-1 rounded-lg border border-slate-700 bg-slate-800/95 p-2 text-xs shadow-xl backdrop-blur"
    >
      <div className="px-1 font-semibold text-slate-300">מוסיף קבצים…</div>
      {items.map((it) => (
        <div key={it.key} className="flex items-center gap-1.5 rounded px-1 py-0.5" data-status={it.status}>
          {it.status === 'loading' ? (
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-500 border-t-sky-400" />
          ) : it.status === 'error' ? (
            <span className="shrink-0 text-red-400">!</span>
          ) : (
            <span className="h-3 w-3 shrink-0 rounded-full border-2 border-slate-600" />
          )}
          <IconFilePdf size={13} className="shrink-0 text-red-400" />
          <span className="min-w-0 flex-1 truncate" dir="auto" title={it.error ?? it.name}>
            {it.name}
          </span>
          {it.status === 'error' ? (
            <button type="button" onClick={() => dismiss(it.key)} className="rounded px-1 text-slate-400 hover:text-white" aria-label="סגור">
              ×
            </button>
          ) : (
            <span className="shrink-0 font-mono text-slate-500" dir="ltr">
              {it.status === 'loading' ? 'טוען' : formatBytes(it.size)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
