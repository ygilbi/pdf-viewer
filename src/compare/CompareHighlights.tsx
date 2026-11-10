import { memo, useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewer } from '../state/store';
import { regionKind, shownRegions, useCompare, KIND_LABEL } from './compareStore';
import { loadOverlay } from './runCompare';

const px = (n: number) => `calc(${n}px * var(--inv-zoom, 1))`;

/**
 * Version compare on the current page (page units, inside the transformed world):
 *  - marker mode: glowing highlighter boxes on the changed areas, coloured by
 *    type (green added / red removed / amber modified), numbered;
 *  - overlay mode: both versions' ink drawn together — unchanged faded, added
 *    green, removed red (Forma-style 2D overlay) — with the boxes on top;
 *  - a page badge with the number of changes.
 * Borders / glow / labels stay screen-sized via --inv-zoom.
 */
export const CompareHighlights = memo(function CompareHighlights({ page }: { page: number }) {
  const doc = useViewer((s) => s.docs.find((d) => page > d.pageOffset && page <= d.pageOffset + d.numPages));
  const size = useViewer((s) => s.pageSizes[page - 1]);
  const local = doc ? page - doc.pageOffset : 0;
  const c = useCompare(
    useShallow((s) => ({
      regions: s.regions,
      notes: s.notes,
      filter: s.filter,
      visible: s.visible,
      mode: s.mode,
      newId: s.newId,
      oldId: s.oldId,
      status: s.status,
      pairOf: s.pairOf,
      diffed: s.diffed,
      selected: s.selected,
    })),
  );
  const role = doc?.id === c.newId ? 'new' : doc?.id === c.oldId ? 'old' : null;
  const note = doc ? c.notes[doc.id]?.[local] : undefined;
  const regions = useMemo(() => (doc ? shownRegions(c, doc.id, local) : []), [c, doc, local]);
  const newLocal = role === 'new' ? local : role === 'old' ? c.pairOf[c.oldId!]?.[local] : undefined;
  const compared = !!note || (newLocal != null && !!c.diffed[newLocal]);
  const overlayOn = c.visible && c.mode === 'overlay' && !note && newLocal != null && compared;

  useEffect(() => {
    if (overlayOn && doc) void loadOverlay(doc.id, local);
  }, [overlayOn, doc, local]);

  if (!doc || !size || !role || !c.visible) return null;
  const n = regions.length;
  const W = size.width;
  const H = size.height;
  return (
    <div className="pointer-events-none absolute left-0 top-0" style={{ width: W, height: H, zIndex: 16 }} data-testid="compare-highlights" data-count={n} data-mode={c.mode}>
      {overlayOn && <OverlayCanvas newLocal={newLocal!} />}
      {!note &&
        regions.map((r, i) => {
          const kind = regionKind(r);
          const sel = c.selected?.docId === doc.id && c.selected.local === local && c.selected.index === i;
          return (
            <div
              key={i}
              className={`cmp-mark cmp-${kind} absolute${sel ? ' cmp-sel' : ''}${c.mode === 'overlay' ? ' cmp-thin' : ''}`}
              data-testid="compare-mark"
              data-kind={kind}
              title={KIND_LABEL[kind]}
              style={{ left: r.x * W, top: r.y * H, width: r.width * W, height: r.height * H }}
            >
              <span className="cmp-tag" style={{ fontSize: px(11), minWidth: px(18), height: px(18), lineHeight: px(18), top: px(-9), right: px(-9) }}>
                {i + 1}
              </span>
            </div>
          );
        })}
      {note && n > 0 && <div className={`cmp-mark cmp-whole cmp-${note} absolute inset-0`} data-testid="compare-mark" data-kind={note} />}
      {compared && (
        <div
          className="cmp-badge absolute"
          dir="rtl"
          data-testid="compare-page-badge"
          style={{ right: 0, top: 0, transformOrigin: '100% 0', transform: 'scale(var(--inv-zoom, 1)) translate(-8px, 8px)' }}
        >
          {note === 'added'
            ? 'דף חדש בגרסה זו'
            : note === 'removed'
              ? 'הדף הוסר בגרסה החדשה'
              : n === 0
                ? 'ללא שינויים בדף'
                : n === 1
                  ? 'שינוי אחד בדף'
                  : `${n} שינויים בדף`}
          <span className="cmp-badge-sub">{role === 'new' ? 'גרסה חדשה' : 'גרסה קודמת'}</span>
        </div>
      )}
    </div>
  );
});

/** Overlay colours (RGB): added (new only), removed (old only). */
const OVERLAY_RGB = { added: [22, 163, 74], removed: [220, 38, 38] } as const;
/** Alpha of the white wash over unchanged ink / paper: the sharp page shows through, faded, so the colours stand out. */
const WASH_ALPHA = 115;

/**
 * Paints the overlay of the pair over the (still sharp) page render: unchanged
 * areas washed out, added ink green, removed ink red — thickened by 1px so
 * thin lines stay visible when zoomed out. Layers switch the colours off.
 */
function OverlayCanvas({ newLocal }: { newLocal: number }) {
  const overlay = useCompare((s) => (s.overlay?.newLocal === newLocal ? s.overlay : null));
  const loading = useCompare((s) => s.overlayLoading);
  const layers = useCompare((s) => s.layers);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !overlay) return;
    const { w, h, classes } = overlay;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    // 1px dilation of the shown change classes (removed wins over added where they touch).
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = classes[y * w + x];
        if (!((k === 2 && layers.new) || (k === 3 && layers.old))) continue;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
          for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
            const i = yy * w + xx;
            if (out[i] !== 3) out[i] = k;
          }
      }
    }
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      const k = out[i];
      const rgb = k === 2 ? OVERLAY_RGB.added : k === 3 ? OVERLAY_RGB.removed : null;
      if (rgb) {
        d[j] = rgb[0];
        d[j + 1] = rgb[1];
        d[j + 2] = rgb[2];
        d[j + 3] = 255;
      } else {
        d[j] = d[j + 1] = d[j + 2] = 255;
        d[j + 3] = WASH_ALPHA;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [overlay, layers]);
  return (
    <>
      <canvas ref={ref} className="absolute inset-0 h-full w-full" style={{ display: overlay ? 'block' : 'none' }} data-testid="compare-overlay" />
      {!overlay && loading && (
        <div className="absolute inset-0 flex items-start justify-center bg-white/60" style={{ paddingTop: px(60) }}>
          <span className="cmp-badge" style={{ transform: 'scale(var(--inv-zoom, 1))', transformOrigin: '50% 0' }}>
            בונה שכבות…
          </span>
        </div>
      )}
    </>
  );
}
