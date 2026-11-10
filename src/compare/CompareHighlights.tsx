import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewer } from '../state/store';
import { regionKind, shownRegions, useCompare, KIND_LABEL } from './compareStore';

const px = (n: number) => `calc(${n}px * var(--inv-zoom, 1))`;

/**
 * Version compare on the current page (page units, inside the transformed world):
 *  - marker mode: glowing highlighter boxes on the changed areas, coloured by
 *    type (green added / red removed / amber modified), numbered;
 *  - layers mode (FormaLayers draws the versions): the boxes only when "סמן אזורים" is on;
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
      regionsOn: s.regionsOn,
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
  const boxes = c.mode === 'marker' || c.regionsOn;

  if (!doc || !size || !role || !c.visible) return null;
  const n = regions.length;
  const W = size.width;
  const H = size.height;
  return (
    <div className="pointer-events-none absolute left-0 top-0" style={{ width: W, height: H, zIndex: 16 }} data-testid="compare-highlights" data-count={n} data-mode={c.mode}>
      {boxes &&
        !note &&
        regions.map((r, i) => {
          const kind = regionKind(r);
          const sel = c.selected?.docId === doc.id && c.selected.local === local && c.selected.index === i;
          return (
            <div
              key={i}
              className={`cmp-mark cmp-${kind} absolute${sel ? ' cmp-sel' : ''}${c.mode === 'layers' ? ' cmp-thin' : ''}`}
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
      {boxes && note && n > 0 && <div className={`cmp-mark cmp-whole cmp-${note} absolute inset-0`} data-testid="compare-mark" data-kind={note} />}
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
