import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../state/store';
import { buildMeasurementRows, measurementsToTSV } from '../core/measurementEngine';
import { ToolButton } from './ui/ToolButton';
import { IconCopy } from './ui/icons';
import { persistentMeasurements } from '../core/tempMeasurements';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** RTL HTML table (first row = header) so Excel / Word keep columns and direction. */
export function rowsToHtmlTable(rows: string[][]): string {
  const [head, ...body] = rows;
  const tr = (r: string[], tag: 'th' | 'td') =>
    `<tr>${r.map((c) => `<${tag} style="text-align:right">${escapeHtml(c)}</${tag}>`).join('')}</tr>`;
  return (
    '<meta charset="utf-8"><table dir="rtl" style="direction:rtl" border="1" cellspacing="0">' +
    (head ? `<thead>${tr(head, 'th')}</thead>` : '') +
    `<tbody>${body.map((r) => tr(r, 'td')).join('')}</tbody></table>`
  );
}

async function copyToClipboard(tsv: string, html: string): Promise<boolean> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clip) return false;
  if (typeof clip.write === 'function' && typeof ClipboardItem !== 'undefined') {
    try {
      await clip.write([
        new ClipboardItem({
          'text/plain': new Blob([tsv], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return true;
    } catch {
      /* fall back to plain text */
    }
  }
  try {
    await clip.writeText(tsv);
    return true;
  } catch {
    return false;
  }
}

/** "Copy table" — clipboard export that works inside sandboxed iframes where downloads are blocked. */
export function CopyTableButton({ disabled }: { disabled?: boolean }) {
  const [toast, setToast] = useState(0);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(0), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const onClick = () => {
    const s = useViewer.getState();
    const tsv = measurementsToTSV(persistentMeasurements(s.measurements), s.calibrations, s.categories);
    const html = rowsToHtmlTable(buildMeasurementRows(persistentMeasurements(s.measurements), s.calibrations, s.categories));
    // Called synchronously from the click handler so the user gesture is still active.
    void copyToClipboard(tsv, html).then((ok) => (ok ? setToast(Date.now()) : setFallback(tsv)));
  };

  return (
    <>
      <ToolButton label="העתק טבלה" hint="להדבקה באקסל / Google Sheets" disabled={disabled} onClick={onClick} showLabel>
        <IconCopy />
      </ToolButton>
      {/* Portaled: the button may live inside a transformed (sliding) menu, which would re-anchor `fixed`. */}
      {toast > 0 &&
        createPortal(
        <div
          role="status"
          data-testid="copy-toast"
          className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-emerald-700 bg-emerald-950/90 px-4 py-2 text-sm text-emerald-100 shadow-lg"
        >
          הטבלה הועתקה — הדבק באקסל
        </div>,
          document.body,
        )}
      {fallback != null &&
        createPortal(<CopyFallbackModal text={fallback} onClose={() => setFallback(null)} />, document.body)}
    </>
  );
}

function CopyFallbackModal({ text, onClose }: { text: string; onClose(): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="העתקת טבלה"
        data-testid="copy-fallback"
        className="flex w-full max-w-2xl flex-col gap-2 rounded-lg border border-slate-600 bg-slate-800 p-4 text-slate-200 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">העתקת טבלה</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
          >
            סגור
          </button>
        </div>
        <p className="text-xs text-amber-300">הגישה ללוח נחסמה. לחץ Ctrl+C להעתקה, ואז הדבק באקסל.</p>
        <textarea
          ref={ref}
          readOnly
          dir="rtl"
          value={text}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            e.stopPropagation(); // keep tool shortcuts from firing
            if (e.key === 'Escape') onClose();
          }}
          className="h-64 w-full resize-none rounded border border-slate-600 bg-slate-950 p-2 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
          style={{ tabSize: 12 }}
        />
      </div>
    </div>
  );
}
