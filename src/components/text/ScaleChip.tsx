import { useEffect, useRef, useState } from 'react';
import { useViewer } from '../../state/store';
import { usePageTextInfo } from '../../text/pageTextInfo';
import { calibrationFromScale, type DetectedScale } from '../../text/scaleDetect';
import { useAfterFirstPaint, usePagePainted } from '../../state/firstPaint';

/** Pages (doc:local or global fallback) where the user dismissed the suggestion — per session. */
const dismissed = new Set<string>();

function applyScale(d: DetectedScale) {
  const s = useViewer.getState();
  s.setCalibration(s.currentPage, calibrationFromScale(d, s.pageSizes[s.currentPage - 1]));
}

/**
 * Auto scale detection reads the page text, which competes with drawing the page: it starts only
 * once the current page is on screen and the browser went idle after the first paint.
 */
export function ScaleChip({ placement = 'below' }: { placement?: 'below' | 'above' }) {
  const calibrated = useViewer((s) => !!s.calibrations[s.currentPage]);
  const painted = usePagePainted();
  const idle = useAfterFirstPaint();
  if (calibrated || !painted || !idle) return null;
  return <ScaleChipInner placement={placement} />;
}

/**
 * "כיול אוטומטי": non-blocking chip in the floating pill when the current page
 * is not calibrated and its text names a scale ("SCALE 1:100", "קנ״מ 1:50").
 * Several different scales → a small picker.
 */
function ScaleChipInner({ placement }: { placement: 'below' | 'above' }) {
  const page = useViewer((s) => s.currentPage);
  const calibrated = useViewer((s) => !!s.calibrations[s.currentPage]);
  const docKey = useViewer((s) => s.docs.map((d) => d.id).join(','));
  const info = usePageTextInfo(page);
  const [, force] = useState(0);
  const [pick, setPick] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const key = `${docKey}|${page}`;

  useEffect(() => setPick(false), [key]);
  useEffect(() => {
    if (!pick) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPick(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [pick]);

  if (calibrated || info.status !== 'ready' || info.scales.length === 0 || dismissed.has(key)) return null;
  const scales = info.scales;
  const one = scales.length === 1 ? scales[0] : null;
  const dismiss = () => {
    dismissed.add(key);
    force((n) => n + 1);
  };

  return (
    <div ref={ref} className="relative me-0.5 flex items-center" data-testid="scale-chip">
      <div className="flex h-7 items-center overflow-hidden whitespace-nowrap rounded-full border border-emerald-600/70 bg-emerald-900/40 text-[11px] text-emerald-200">
        <button
          type="button"
          className="flex h-full items-center gap-1 ps-2 pe-1.5 hover:bg-emerald-800/60"
          title={
            one
              ? `נמצא בטקסט של הדף: ${one.label}. מחושב לפי הדפסה ב‑100% — מומלץ לאמת מול מידה ידועה.`
              : 'נמצאו כמה קני מידה בדף — בחר את המתאים'
          }
          onClick={() => (one ? applyScale(one) : setPick(!pick))}
          data-testid="scale-chip-apply"
          aria-expanded={one ? undefined : pick}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {one ? (
            <>
              נמצא קנ״מ <span dir="ltr">{one.label}</span> — להחיל?
            </>
          ) : (
            <>נמצאו {scales.length} קני מידה — לבחור?</>
          )}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="התעלם מהקנ״מ שנמצא"
          title="התעלם"
          className="flex h-full items-center px-1.5 text-emerald-300/80 hover:bg-emerald-800/60 hover:text-white"
          data-testid="scale-chip-dismiss"
        >
          ×
        </button>
      </div>
      {pick && !one && (
        <div
          className={
            (placement === 'above' ? 'bottom-9 ' : 'top-9 ') +
            'absolute end-0 z-50 w-64 rounded-lg border border-slate-600 bg-slate-900/95 p-2 text-xs text-slate-200 shadow-xl backdrop-blur'
          }
          data-testid="scale-picker"
        >
          <div className="mb-1.5 text-slate-400">קני מידה שנמצאו בדף (לפי מספר הופעות):</div>
          {scales.map((d) => (
            <button
              key={d.label}
              type="button"
              onClick={() => {
                applyScale(d);
                setPick(false);
              }}
              className="flex w-full items-center justify-between rounded px-2 py-1 hover:bg-slate-700"
              data-testid="scale-option"
            >
              <span dir="ltr" className="font-mono">
                {d.label}
              </span>
              <span className="text-slate-400">×{d.count}</span>
            </button>
          ))}
          <div className="mt-1.5 border-t border-slate-700 pt-1.5 text-[11px] leading-snug text-amber-300/90">
            בדפים עם כמה קני מידה (פרטים וחזיתות) — החל את קנ״מ האזור שאותו מודדים, ואמת מול מידה ידועה בשרטוט.
          </div>
        </div>
      )}
    </div>
  );
}
