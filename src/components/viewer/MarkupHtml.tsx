import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AreaMeasurement } from '../../core/types';
import { NOTE_PIN } from '../../core/markupGeometry';
import { useViewer } from '../../state/store';
import { useMarkup } from '../../state/markupStore';
import { useDocEdit } from '../../state/docEditStore';
import { TEXT_EDIT_PAD, estimateTextWidth, textEditCoverRect, textEditFontSize } from '../../core/docTools';

/**
 * HTML parts of the markup layer, living inside the transformed "world"
 * element (page units) and scaled by --inv-zoom so they stay screen-sized:
 *  - comment bubbles of note pins (shown for the selected note; hover shows
 *    them imperatively via the `data-hover` attribute — no React render)
 *  - the in-place text editor for note / text annotations.
 */

/** Touch-first device (phone / tablet): the in-place editors behave differently there. */
const isCoarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

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

/** In-place editor for the annotation being edited: target page for links, text otherwise. */
export function MarkupEditor({ m }: { m: AreaMeasurement }) {
  if (m.kind === 'textEdit') return <TextEditEditor m={m} isNew={false} />;
  return m.kind === 'link' ? <LinkEditor m={m} /> : <TextEditor m={m} />;
}

const EDIT_FONT = 'system-ui, "Segoe UI", Arial, sans-serif';

/**
 * Edit-text tool editor (cover-and-replace). Desktop: an opaque input exactly over the cover
 * rectangle, in page units (so it matches the run's size and direction) + a small screen-sized
 * toolbar above it. Phones: a fixed card (portal, 16px input, no autofocus) — never a focused
 * input inside the zooming layer. `isNew` = the pending edit (useDocEdit), committed with ONE
 * addMeasurement; an existing one is changed with one updateMeasurement.
 */
export function TextEditEditor({ m, isNew }: { m: AreaMeasurement; isNew: boolean }) {
  const [value, setValue] = useState(m.text ?? '');
  const [rtl, setRtl] = useState(!!m.rtl);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const coarse = isCoarse();

  useEffect(() => {
    if (coarse) return;
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    if (isNew) useDocEdit.getState().setPending(null);
    else if (useMarkup.getState().editingId === m.id) useMarkup.getState().stopEditing();
  };
  const save = () => {
    if (done.current) return;
    done.current = true;
    const s = useViewer.getState();
    if (isNew) s.addMeasurement({ ...m, text: value, rtl });
    else if (value !== (m.text ?? '') || rtl !== !!m.rtl) s.updateMeasurement(m.id, { text: value, rtl });
    close();
    // Leave the drawing unselected after a new edit (the white cover reads as part of the sheet).
    if (isNew && useViewer.getState().selectedId === m.id) useViewer.getState().select(null);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    close();
  };
  const remove = () => {
    done.current = true;
    useViewer.getState().removeMeasurement(m.id);
    close();
  };
  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const live = { ...m, text: value, rtl };
  const cover = textEditCoverRect(live);
  const fs = textEditFontSize(m);
  const buttons = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={save}
        data-testid="text-edit-save"
        className="rounded bg-sky-600 px-2 py-0.5 text-[12px] font-medium text-white hover:bg-sky-700"
      >
        שמור
      </button>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={cancel} className="rounded px-2 py-0.5 text-[12px] text-slate-600 hover:bg-slate-100">
        ביטול
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setRtl((v) => !v)}
        title="כיוון הטקסט"
        className="rounded px-1.5 py-0.5 text-[12px] text-slate-600 hover:bg-slate-100"
        data-testid="text-edit-dir"
      >
        {rtl ? 'ימין←שמאל' : 'שמאל→ימין'}
      </button>
      {!isNew && (
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={remove} className="ms-auto rounded px-2 py-0.5 text-[12px] text-rose-600 hover:bg-rose-50">
          שחזר מקור
        </button>
      )}
    </div>
  );

  if (coarse) {
    return createPortal(
      <div data-viewer-ui className="fixed inset-x-0 top-24 flex justify-center px-3" style={{ zIndex: 60, pointerEvents: 'none' }} onPointerDown={(e) => e.stopPropagation()}>
        <div dir="rtl" className="w-72 rounded-lg bg-white p-2 shadow-xl ring-1 ring-black/20" style={{ borderTop: '3px solid #0ea5e9', pointerEvents: 'auto', touchAction: 'none' }}>
          <div className="mb-1 text-[11px] font-semibold text-slate-600">{m.origText ? `עריכת טקסט: ${m.origText}` : 'טקסט חדש על כיסוי'}</div>
          <input
            ref={ref}
            type="text"
            dir={rtl ? 'rtl' : 'ltr'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={keys}
            data-testid="text-edit-input"
            className="mb-1.5 block w-full rounded border border-slate-300 px-1.5 py-1 text-base text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
          />
          {buttons}
        </div>
      </div>,
      document.body,
    );
  }

  // Desktop: in place, in page units.
  const width = Math.max(cover.width, estimateTextWidth(live) + 2 * fs * TEXT_EDIT_PAD);
  const left = rtl ? cover.x + cover.width - width : cover.x;
  return (
    <div
      data-viewer-ui
      className="absolute"
      style={{ left, top: cover.y, width, height: cover.height, pointerEvents: 'auto', zIndex: 45 }}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) save();
      }}
    >
      <input
        ref={ref}
        type="text"
        dir={rtl ? 'rtl' : 'ltr'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={keys}
        data-testid="text-edit-input"
        className="block h-full w-full border-0 bg-white p-0 text-black"
        style={{
          fontSize: fs,
          lineHeight: 1,
          fontFamily: EDIT_FONT,
          paddingInline: fs * TEXT_EDIT_PAD,
          color: m.color || '#000',
          outline: 'calc(2px * var(--inv-zoom, 1)) solid #0ea5e9',
        }}
      />
      <div
        dir="rtl"
        className="absolute rounded-lg bg-white p-1 shadow-xl ring-1 ring-black/20"
        style={{ right: 0, top: 0, transformOrigin: '100% 0', transform: 'scale(var(--inv-zoom, 1)) translate(0, calc(-100% - 8px))', whiteSpace: 'nowrap' }}
      >
        <div className="mb-0.5 px-1 text-[10px] text-slate-500">Enter שמירה · Esc ביטול</div>
        {buttons}
      </div>
    </div>
  );
}

/**
 * Target-page picker of a link area (Enter = save, Esc = cancel; cancelling a new link removes it).
 * Pages are the workspace's global pages, shown with their file name when several files are open.
 */
function LinkEditor({ m }: { m: AreaMeasurement }) {
  const numPages = useViewer((s) => s.numPages);
  const docs = useViewer((s) => s.docs);
  const ref = useRef<HTMLInputElement>(null);
  const isNew = useRef(useMarkup.getState().editingIsNew);
  const [value, setValue] = useState(String(m.targetPage ?? Math.min(numPages, m.page + 1)));
  const [name, setName] = useState(m.text ?? '');
  const [ref2, setRef2] = useState(m.refLabel ?? '');
  const done = useRef(false);
  const id = m.id;

  useEffect(() => {
    // Phones: no autofocus — the keyboard would pop up over a layer that is being zoomed.
    if (isCoarse()) return;
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);

  const n = Math.round(Number(value));
  const valid = Number.isFinite(n) && n >= 1 && n <= numPages;
  const fileOf = (page: number): string | null => {
    if (docs.length < 2) return null;
    const d = docs.find((x) => page > x.pageOffset && page <= x.pageOffset + x.numPages);
    return d ? `${d.name} · עמוד ${page - d.pageOffset}` : null;
  };

  const close = () => {
    if (useMarkup.getState().editingId === id) useMarkup.getState().stopEditing();
    // Don't leave the link selected (handles + fill) after editing — on iPhone the selected callout
    // was the state in which pinch-zoom crashed the tab.
    if (useViewer.getState().selectedId === id) useViewer.getState().select(null);
  };
  const save = () => {
    if (!valid || done.current) return;
    done.current = true;
    const refLabel = ref2.trim();
    useViewer.getState().updateMeasurement(id, { targetPage: n, text: name.trim(), refLabel: refLabel || undefined });
    close();
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    if (isNew.current) useViewer.getState().removeMeasurement(id);
    close();
  };
  const remove = () => {
    done.current = true;
    useViewer.getState().removeMeasurement(id);
    close();
  };

  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const p = m.points[0];
  if (!p) return null;
  // Phones: a fixed card on top of the screen (portal, outside the zoomed drawing layer), so pinch
  // zoom never moves or re-lays-out a focused input. Desktop: next to the link, like before.
  const coarse = isCoarse();
  const card = (
    <div
      data-viewer-ui
      className={coarse ? 'fixed inset-x-0 top-24 flex justify-center px-3' : 'absolute'}
      style={
        coarse
          ? // The full-width centring strip is transparent: it must not swallow touches (a pinch whose
            // finger landed in it reached the viewer as a 1-finger drag → drew a new link instead of
            // zooming, and the strip's touch-action:auto let the browser zoom the whole page).
            { zIndex: 60, pointerEvents: 'none' }
          : {
              left: p.x,
              top: p.y,
              transformOrigin: '0 0',
              transform: 'scale(var(--inv-zoom, 1)) translate(0, calc(-100% - 8px))',
              pointerEvents: 'auto',
              zIndex: 45,
            }
      }
      onPointerDown={(e) => e.stopPropagation()}      onBlur={(e) => {
        // Focus left the editor (click on the drawing…): keep a valid page, otherwise drop it.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          if (valid) save();
          else cancel();
        }
      }}
    >
      <div
        dir="rtl"
        className="w-60 rounded-lg bg-white p-2 shadow-xl ring-1 ring-black/20"
        // Phones: only the card itself takes touches, and never as a native page pinch / scroll.
        style={{ borderTop: '3px solid #0284c7', ...(coarse ? { pointerEvents: 'auto', touchAction: 'none' } : {}) }}
      >
        <div className="mb-1.5 grid grid-cols-2 gap-1.5">
          <label className="text-[11px] font-semibold text-slate-600">
            שם הקישור
            <input
              ref={ref}
              type="text"
              value={name}
              maxLength={12}
              placeholder="A1"
              data-testid="link-name-input"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={keys}
              className="mt-0.5 block w-full rounded border border-slate-300 px-1.5 py-1 text-[13px] [@media(pointer:coarse)]:text-base font-normal text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
            />
          </label>
          <label className="text-[11px] font-semibold text-slate-600">
            תווית (רשות)
            <input
              type="text"
              value={ref2}
              maxLength={16}
              placeholder="SIM"
              data-testid="link-ref-input"
              onChange={(e) => setRef2(e.target.value)}
              onKeyDown={keys}
              className="mt-0.5 block w-full rounded border border-slate-300 px-1.5 py-1 text-[13px] [@media(pointer:coarse)]:text-base font-normal text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
            />
          </label>
        </div>
        <label className="mb-1 block text-[11px] font-semibold text-slate-600" htmlFor={`link-${id}`}>
          קישור לעמוד
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id={`link-${id}`}
            type="number"
            inputMode="numeric"
            min={1}
            max={numPages}
            value={value}
            data-testid="link-target"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={keys}
            className={`w-20 rounded border px-1.5 py-1 text-[13px] [@media(pointer:coarse)]:text-base text-slate-800 outline-none focus:ring-2 ${valid ? 'border-slate-300 focus:border-sky-500 focus:ring-sky-200' : 'border-rose-400 focus:ring-rose-200'}`}
          />
          <span className="text-[12px] text-slate-500">מתוך {numPages}</span>
        </div>
        <div className="mt-1 min-h-[14px] text-[10.5px] text-slate-500">
          {valid ? fileOf(n) : <span className="text-rose-600">מספר עמוד בין 1 ל-{numPages}</span>}
        </div>
        <div className="mt-1.5 flex gap-1">
          <button
            type="button"
            disabled={!valid}
            onClick={save}
            data-testid="link-save"
            className="rounded bg-sky-600 px-2 py-0.5 text-[12px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
          >
            שמור
          </button>
          <button type="button" onClick={cancel} className="rounded px-2 py-0.5 text-[12px] text-slate-600 hover:bg-slate-100">
            ביטול
          </button>
          {!isNew.current && (
            <button type="button" onClick={remove} className="ms-auto rounded px-2 py-0.5 text-[12px] text-rose-600 hover:bg-rose-50">
              מחק קישור
            </button>
          )}
        </div>
      </div>
    </div>
  );
  return coarse ? createPortal(card, document.body) : card;
}

/** Floating textarea that edits an annotation's text live (Enter = done, Shift+Enter = new line, Esc = cancel). */
function TextEditor({ m }: { m: AreaMeasurement }) {
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
          className="block w-60 resize rounded border border-slate-300 px-1.5 py-1 text-[13px] [@media(pointer:coarse)]:text-base leading-snug text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
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
