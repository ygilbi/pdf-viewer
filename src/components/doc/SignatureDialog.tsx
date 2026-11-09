import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSignatures } from '../../state/signatureStore';
import { useViewer } from '../../state/store';
import type { Point } from '../../core/types';
import {
  SIGNATURE_MAX_BYTES,
  dataUrlByteSize,
  fitScale,
  inkBounds,
  removeWhiteBackground,
  smoothStroke,
} from '../../core/signatureImage';

/**
 * Create / choose a signature: draw it (finger, mouse or pen), type it (rendered in a
 * handwriting-style system font — nothing is downloaded), or upload a PNG / JPG (trimmed, white
 * background optionally removed). Saved on this device only. The placed signature is a visual
 * one (an image), not a certified digital signature.
 */

type Tab = 'draw' | 'type' | 'upload';

/** Handwriting-like system fonts (no download): Windows, macOS / iOS, then the generic cursive. */
const SCRIPT_FONTS: { label: string; family: string }[] = [
  { label: 'כתב יד 1', family: '"Segoe Script", "Snell Roundhand", "Brush Script MT", "Apple Chancery", cursive' },
  { label: 'כתב יד 2', family: '"Brush Script MT", "Bradley Hand", "Segoe Print", "Noteworthy", cursive' },
  { label: 'כתב יד 3', family: '"Segoe Print", "Noteworthy", "Comic Sans MS", "Marker Felt", cursive' },
];
const INKS = ['#111827', '#1d4ed8'];

/** Crop a canvas to its ink, fit it into the stored size and encode a PNG (≤ SIGNATURE_MAX_BYTES). */
function finalize(src: HTMLCanvasElement, removeBg: boolean): { image: string; aspect: number } | null {
  const ctx = src.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const px = ctx.getImageData(0, 0, src.width, src.height);
  if (removeBg) {
    removeWhiteBackground(px);
    ctx.putImageData(px, 0, 0);
  }
  const b = inkBounds(px, 10, Math.round(Math.max(src.width, src.height) * 0.01));
  if (!b) return null;
  let scale = fitScale(b.width, b.height);
  for (let attempt = 0; attempt < 8; attempt++) {
    const w = Math.max(1, Math.round(b.width * scale));
    const h = Math.max(1, Math.round(b.height * scale));
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const o = out.getContext('2d')!;
    o.imageSmoothingQuality = 'high';
    o.drawImage(src, b.x, b.y, b.width, b.height, 0, 0, w, h);
    const image = out.toDataURL('image/png');
    if (dataUrlByteSize(image) <= SIGNATURE_MAX_BYTES || w < 80) return { image, aspect: b.width / b.height };
    scale *= 0.8;
  }
  return null;
}

export function SignatureDialog() {
  const open = useSignatures((s) => s.dialogOpen);
  if (!open) return null;
  return createPortal(<DialogBody />, document.body);
}

function DialogBody() {
  const saved = useSignatures((s) => s.saved);
  const withDate = useSignatures((s) => s.withDate);
  const [tab, setTab] = useState<Tab>(saved.length ? 'draw' : 'draw');
  const [error, setError] = useState('');

  const cancel = () => {
    const sig = useSignatures.getState();
    sig.closeDialog();
    // Nothing to place → leave the tool (back to the hand tool).
    if (!sig.active && useViewer.getState().tool === 'signature') useViewer.getState().setTool('pan');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const use = (r: { image: string; aspect: number } | null, save: boolean) => {
    if (!r) {
      setError('לא נמצאה חתימה — צייר, הקלד או העלה תמונה');
      return;
    }
    if (save) useSignatures.getState().add(r);
    else useSignatures.getState().choose(r);
  };

  return (
    <div
      data-viewer-ui
      className="fixed inset-0 flex items-start justify-center overflow-y-auto bg-black/40 p-3 pt-[max(12px,env(safe-area-inset-top))] sm:items-center"
      style={{ zIndex: 80 }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      data-testid="signature-dialog"
    >
      <div dir="rtl" className="w-full max-w-[560px] rounded-xl bg-white p-3 text-slate-800 shadow-2xl ring-1 ring-black/10">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[15px] font-semibold">חתימה</h2>
          <span className="flex-1" />
          <button type="button" onClick={cancel} className="rounded px-2 py-0.5 text-[13px] text-slate-500 hover:bg-slate-100" aria-label="סגור">
            ✕
          </button>
        </div>

        {saved.length > 0 && (
          <div className="mb-3">
            <div className="mb-1 text-[12px] font-semibold text-slate-600">חתימות שמורות במכשיר</div>
            <div className="flex flex-wrap gap-2" data-testid="saved-signatures">
              {saved.map((s) => (
                <div key={s.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => use(s, false)}
                    className="flex h-14 w-32 items-center justify-center rounded-lg border border-slate-300 bg-white p-1 hover:border-sky-500 hover:ring-2 hover:ring-sky-200"
                    title="השתמש בחתימה זו"
                    data-testid="saved-signature"
                  >
                    <img src={s.image} alt="חתימה שמורה" className="max-h-full max-w-full object-contain" />
                  </button>
                  <button
                    type="button"
                    onClick={() => useSignatures.getState().remove(s.id)}
                    className="absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-[11px] text-rose-600 shadow ring-1 ring-black/15 hover:bg-rose-50"
                    title="מחק חתימה"
                    aria-label="מחק חתימה"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-2 flex gap-1 rounded-lg bg-slate-100 p-0.5 text-[13px]" role="tablist">
          {(
            [
              ['draw', 'ציור'],
              ['type', 'הקלדה'],
              ['upload', 'העלאת תמונה'],
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                setTab(t);
                setError('');
              }}
              className={`flex-1 rounded-md px-2 py-1 ${tab === t ? 'bg-white font-semibold shadow' : 'text-slate-600'}`}
              data-testid={`signature-tab-${t}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'draw' && <DrawPad onUse={(c) => use(c && finalize(c, false), true)} />}
        {tab === 'type' && <TypePad onUse={(c) => use(c && finalize(c, false), true)} />}
        {tab === 'upload' && <UploadPad onUse={(c, bg) => use(c && finalize(c, bg), true)} />}

        {error && <div className="mt-1 text-[12px] text-rose-600">{error}</div>}

        <label className="mt-2 flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={withDate} onChange={(e) => useSignatures.getState().setWithDate(e.target.checked)} data-testid="signature-date" />
          הוסף שורת תאריך מתחת לחתימה
        </label>
        <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
          חתימה חזותית (תמונה על הדף) — אינה חתימה דיגיטלית מאושרת. החתימות נשמרות רק במכשיר זה.
        </p>
      </div>
    </div>
  );
}

function PadButtons({ onUse, onClear, disabled }: { onUse: () => void; onClear?: () => void; disabled?: boolean }) {
  return (
    <div className="mt-2 flex gap-1.5">
      <button
        type="button"
        disabled={disabled}
        onClick={onUse}
        className="rounded-md bg-sky-600 px-3 py-1 text-[13px] font-medium text-white hover:bg-sky-700 disabled:opacity-40"
        data-testid="signature-use"
      >
        שמור והצב
      </button>
      {onClear && (
        <button type="button" onClick={onClear} className="rounded-md px-3 py-1 text-[13px] text-slate-600 hover:bg-slate-100">
          נקה
        </button>
      )}
    </div>
  );
}

/** Drawing pad: pointer strokes smoothed with quadratic midpoints (coalesced events for pens). */
function DrawPad({ onUse }: { onUse: (c: HTMLCanvasElement | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const cur = useRef<{ id: number; pts: Point[] } | null>(null);
  const [ink, setInk] = useState(INKS[0]);
  const [empty, setEmpty] = useState(true);
  const inkRef = useRef(ink);
  inkRef.current = ink;

  const redraw = () => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const dpr = c.width / c.clientWidth || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = inkRef.current;
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of [...strokes.current, ...(cur.current ? [cur.current.pts] : [])]) {
      ctx.beginPath();
      for (const cmd of smoothStroke(s)) {
        if (cmd.t === 'Q') ctx.quadraticCurveTo(cmd.c.x, cmd.c.y, cmd.p.x, cmd.p.y);
        else if (cmd.t === 'M') ctx.moveTo(cmd.p.x, cmd.p.y);
        else ctx.lineTo(cmd.p.x, cmd.p.y);
      }
      ctx.stroke();
    }
  };

  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(redraw, [ink]);

  const pos = (e: { clientX: number; clientY: number }): Point => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div>
      <div className="relative">
        <canvas
          ref={ref}
          className="block h-[180px] w-full cursor-crosshair rounded-lg border border-dashed border-slate-300 bg-white"
          style={{ touchAction: 'none' }}
          data-testid="signature-pad"
          onPointerDown={(e) => {
            if (cur.current) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            cur.current = { id: e.pointerId, pts: [pos(e)] };
            redraw();
          }}
          onPointerMove={(e) => {
            const s = cur.current;
            if (!s || s.id !== e.pointerId) return;
            const evs = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
            for (const ev of evs.length ? evs : [e.nativeEvent]) {
              const p = pos(ev);
              const l = s.pts[s.pts.length - 1];
              if (Math.hypot(p.x - l.x, p.y - l.y) >= 0.8) s.pts.push(p);
            }
            redraw();
          }}
          onPointerUp={(e) => {
            const s = cur.current;
            if (!s || s.id !== e.pointerId) return;
            strokes.current.push(s.pts);
            cur.current = null;
            setEmpty(false);
            redraw();
          }}
          onPointerCancel={() => {
            cur.current = null;
            redraw();
          }}
        />
        <div className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-slate-200" />
        {empty && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-slate-400">חתום כאן באצבע, בעכבר או בעט</div>}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[12px] text-slate-600">
        צבע:
        {INKS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setInk(c)}
            className={`h-5 w-5 rounded-full ring-2 ${ink === c ? 'ring-sky-400' : 'ring-transparent'}`}
            style={{ background: c }}
            aria-label={c === INKS[0] ? 'שחור' : 'כחול'}
          />
        ))}
      </div>
      <PadButtons
        disabled={empty}
        onUse={() => onUse(ref.current)}
        onClear={() => {
          strokes.current = [];
          cur.current = null;
          setEmpty(true);
          redraw();
        }}
      />
    </div>
  );
}

/** Typed name in a handwriting-style font, rendered to a canvas. */
function TypePad({ onUse }: { onUse: (c: HTMLCanvasElement | null) => void }) {
  const [name, setName] = useState('');
  const [font, setFont] = useState(0);
  const [ink, setInk] = useState(INKS[0]);
  const render = (): HTMLCanvasElement | null => {
    const t = name.trim();
    if (!t) return null;
    const c = document.createElement('canvas');
    c.width = 1400;
    c.height = 320;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const rtl = /[֐-׿]/.test(t);
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink;
    let size = 150;
    ctx.font = `italic ${size}px ${SCRIPT_FONTS[font].family}`;
    while (size > 30 && ctx.measureText(t).width > c.width - 80) {
      size -= 10;
      ctx.font = `italic ${size}px ${SCRIPT_FONTS[font].family}`;
    }
    ctx.fillText(t, c.width / 2, c.height / 2);
    return c;
  };
  return (
    <div>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="הקלד את שמך"
        className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-base outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
        data-testid="signature-name"
      />
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {SCRIPT_FONTS.map((f, i) => (
          <button
            key={f.label}
            type="button"
            onClick={() => setFont(i)}
            dir="auto"
            className={`h-14 overflow-hidden truncate rounded-lg border px-1 text-[20px] italic ${font === i ? 'border-sky-500 ring-2 ring-sky-200' : 'border-slate-300'}`}
            style={{ fontFamily: f.family, color: ink }}
            title={f.label}
          >
            {name.trim() || 'חתימה'}
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[12px] text-slate-600">
        צבע:
        {INKS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setInk(c)}
            className={`h-5 w-5 rounded-full ring-2 ${ink === c ? 'ring-sky-400' : 'ring-transparent'}`}
            style={{ background: c }}
            aria-label={c === INKS[0] ? 'שחור' : 'כחול'}
          />
        ))}
      </div>
      <PadButtons disabled={!name.trim()} onUse={() => onUse(render())} />
    </div>
  );
}

/** PNG / JPG upload: drawn onto a canvas (≤ 1600 px), then trimmed (+ white removed when asked). */
function UploadPad({ onUse }: { onUse: (c: HTMLCanvasElement | null, removeBg: boolean) => void }) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [preview, setPreview] = useState('');
  const [removeBg, setRemoveBg] = useState(true);
  const [err, setErr] = useState('');
  const onFile = async (f: File | undefined) => {
    setErr('');
    if (!f) return;
    if (!/^image\/(png|jpe?g)$/i.test(f.type)) {
      setErr('יש לבחור קובץ PNG או JPG');
      return;
    }
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k));
      c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d', { willReadFrequently: true })!.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      setCanvas(c);
      setPreview(c.toDataURL('image/png'));
    } catch {
      setErr('לא ניתן לקרוא את התמונה');
    }
  };
  return (
    <div>
      <label className="flex h-[120px] cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-[13px] text-slate-500 hover:bg-slate-100">
        {preview ? <img src={preview} alt="" className="max-h-full max-w-full object-contain" /> : 'בחר תמונת חתימה (PNG / JPG)'}
        <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="signature-file" />
      </label>
      <label className="mt-1.5 flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} />
        הסר רקע לבן
      </label>
      {err && <div className="mt-1 text-[12px] text-rose-600">{err}</div>}
      <PadButtons
        disabled={!canvas}
        onUse={() => {
          if (!canvas) return;
          // Work on a copy so toggling "remove background" and retrying starts from the original.
          const c = document.createElement('canvas');
          c.width = canvas.width;
          c.height = canvas.height;
          c.getContext('2d', { willReadFrequently: true })!.drawImage(canvas, 0, 0);
          onUse(c, removeBg);
        }}
      />
    </div>
  );
}
