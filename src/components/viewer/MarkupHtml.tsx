import { memo, useEffect, useRef } from 'react';
import type { AreaMeasurement } from '../../core/types';
import { NOTE_PIN } from '../../core/markupGeometry';
import { useViewer } from '../../state/store';
import { useMarkup } from '../../state/markupStore';

/**
 * HTML parts of the markup layer, living inside the transformed "world"
 * element (page units) and scaled by --inv-zoom so they stay screen-sized:
 *  - comment bubbles of note pins (shown for the selected note; hover shows
 *    them imperatively via the `data-hover` attribute — no React render)
 *  - the in-place text editor for note / text annotations.
 */

const BUBBLE_GAP = NOTE_PIN.headY + NOTE_PIN.radius + 6;

function NoteBubblesImpl({
  notes,
  selectedId,
  editingId,
}: {
  notes: AreaMeasurement[];
  selectedId: string | null;
  editingId: string | null;
}) {
  return (
    <>
      {notes.map((m) => {
        const p = m.points[0];
        if (!p || m.id === editingId) return null;
        const text = (m.text ?? '').trim();
        const selected = m.id === selectedId;
        return (
          <div
            key={m.id}
            data-note-bubble={m.id}
            data-testid="note-bubble"
            className={`absolute data-[hover]:block ${selected ? 'block' : 'hidden'}`}
            style={{
              left: p.x,
              top: p.y,
              transformOrigin: '0 0',
              transform: `scale(var(--inv-zoom, 1)) translate(-50%, calc(-100% - ${BUBBLE_GAP}px))`,
              zIndex: 35,
              pointerEvents: 'none',
            }}
          >
            <div
              dir="rtl"
              className="max-w-[260px] whitespace-pre-wrap break-words rounded-lg bg-white px-2.5 py-1.5 text-[13px] leading-snug text-slate-800 shadow-lg ring-1 ring-black/15"
              style={{ borderTop: `3px solid ${m.color}`, minWidth: 90 }}
            >
              <div className="mb-0.5 text-[10px] font-semibold text-slate-500">{m.label}</div>
              {text || <span className="italic text-slate-400">(ללא טקסט)</span>}
              {selected && <div className="mt-1 text-[10px] text-slate-400">לחיצה כפולה / Enter לעריכה</div>}
            </div>
          </div>
        );
      })}
    </>
  );
}

export const NoteBubbles = memo(NoteBubblesImpl);

/** Floating textarea that edits an annotation's text live (Enter = done, Shift+Enter = new line, Esc = cancel). */
export function MarkupEditor({ m }: { m: AreaMeasurement }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const original = useRef(m.text ?? '');
  const isNew = useRef(useMarkup.getState().editingIsNew);
  const done = useRef(false);
  const mounted = useRef(false);
  const id = m.id;
  const kind = m.kind;

  useEffect(() => {
    mounted.current = true;
    const el = ref.current;
    if (el) {
      el.focus({ preventScroll: true });
      el.select();
    }
    return () => {
      mounted.current = false;
      // Unmounted without an explicit finish (page change…): keep the text, drop empty new items.
      // Deferred so StrictMode's dev-only unmount/remount doesn't finish the edit.
      setTimeout(() => {
        if (!mounted.current && !done.current) finish(true);
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const s = useViewer.getState();
    const cur = s.measurements.find((x) => x.id === id);
    if (cur) {
      const text = save ? (cur.text ?? '').replace(/\s+$/, '') : original.current;
      if (!text.trim() && (isNew.current || kind === 'text')) s.removeMeasurement(id);
      else if (text !== cur.text) s.updateMeasurement(id, { text });
    }
    if (useMarkup.getState().editingId === id) useMarkup.getState().stopEditing();
  };

  const p = m.points[0];
  if (!p) return null;
  const isNote = kind === 'note';
  return (
    <div
      data-viewer-ui
      className="absolute"
      style={{
        left: p.x,
        top: p.y,
        transformOrigin: '0 0',
        transform: isNote
          ? `scale(var(--inv-zoom, 1)) translate(-50%, calc(-100% - ${BUBBLE_GAP}px))`
          : `scale(var(--inv-zoom, 1)) translate(-100%, -100%) translate(0, -6px)`,
        pointerEvents: 'auto',
        zIndex: 45,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div dir="rtl" className="rounded-lg bg-white p-1.5 shadow-xl ring-1 ring-black/20" style={{ borderTop: `3px solid ${m.color}` }}>
        <div className="mb-1 flex items-center gap-2 text-[10px] text-slate-500">
          <span className="font-semibold">{isNote ? 'הערה' : 'טקסט'}</span>
          <span className="flex-1" />
          <span>Enter לסיום · Shift+Enter שורה חדשה</span>
        </div>
        <textarea
          ref={ref}
          dir="rtl"
          rows={isNote ? 3 : 2}
          value={m.text ?? ''}
          placeholder={isNote ? 'כתוב הערה…' : 'הקלד טקסט…'}
          data-testid="markup-editor"
          onChange={(e) => useViewer.getState().updateMeasurement(id, { text: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              finish(false);
            }
          }}
          onBlur={() => finish(true)}
          className="block w-60 resize rounded border border-slate-300 px-1.5 py-1 text-[13px] leading-snug text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
        />
        <div className="mt-1 flex justify-start gap-1">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => finish(true)}
            className="rounded bg-sky-600 px-2 py-0.5 text-[12px] font-medium text-white hover:bg-sky-700"
          >
            שמור
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => finish(false)}
            className="rounded px-2 py-0.5 text-[12px] text-slate-600 hover:bg-slate-100"
          >
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
