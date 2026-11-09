import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { LAB_LABELS, labSummary, useLab, type LabFlags } from './lab';
import { useLabUi } from './labUi';

/** ☰ → "מעבדת אבחון": switches to isolate what makes the iPhone tab crash (see lab.ts). */
export function CrashLab() {
  const open = useLabUi((s) => s.open);
  const close = useLabUi((s) => s.setOpen);
  const lab = useLab();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
  if (!open) return null;
  const keys = Object.keys(LAB_LABELS) as (keyof LabFlags)[];
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-3 sm:items-center"
      data-viewer-ui
      onClick={() => close(false)}
    >
      <div
        dir="rtl"
        role="dialog"
        aria-label="מעבדת אבחון"
        data-testid="crash-lab"
        className="w-full max-w-sm rounded-2xl bg-slate-900 p-4 text-slate-100 shadow-2xl ring-1 ring-white/15"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-base font-bold">מעבדת אבחון</div>
        <p className="mb-3 text-xs leading-relaxed text-slate-400">
          מדליקים מתג אחד, חוזרים על הפעולה שגורמת לקריסה, ובודקים אם עדיין קורס. כך מוצאים מה גורם לה.
        </p>
        <ul className="space-y-1.5">
          {keys.map((k) => (
            <li key={k}>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-slate-800 p-2.5 active:bg-slate-700">
                <input
                  type="checkbox"
                  checked={lab[k]}
                  data-testid={`lab-${k}`}
                  onChange={(e) => lab.setFlag(k, e.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-amber-400"
                />
                <span>
                  <span className="block text-sm font-semibold">{LAB_LABELS[k].title}</span>
                  <span className="block text-xs text-slate-400">{LAB_LABELS[k].desc}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center gap-2">
          <button type="button" onClick={() => lab.reset()} className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
            אפס הכול
          </button>
          <span className="flex-1 text-center text-[11px] text-slate-500">{labSummary() || 'הכול כבוי'}</span>
          <button type="button" onClick={() => close(false)} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500">
            סגור
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
