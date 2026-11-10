import { memo } from 'react';
import { useViewer } from '../state/store';
import { useCompare } from './compareStore';

const px = (n: number) => `calc(${n}px * var(--inv-zoom, 1))`;

/**
 * Glowing highlighter boxes on the changed areas of the current page (page
 * units, inside the transformed world) + a page badge with the number of
 * changes. Borders / glow / labels stay screen-sized via --inv-zoom.
 */
export const CompareHighlights = memo(function CompareHighlights({ page }: { page: number }) {
  const doc = useViewer((s) => s.docs.find((d) => page > d.pageOffset && page <= d.pageOffset + d.numPages));
  const size = useViewer((s) => s.pageSizes[page - 1]);
  const local = doc ? page - doc.pageOffset : 0;
  const regions = useCompare((s) => (doc ? s.regions[doc.id]?.[local] : undefined));
  const note = useCompare((s) => (doc ? s.notes[doc.id]?.[local] : undefined));
  const visible = useCompare((s) => s.visible);
  const role = useCompare((s) => (doc?.id === s.newId ? 'new' : doc?.id === s.oldId ? 'old' : null));
  const done = useCompare((s) => s.status === 'done' || (s.progress.done >= local && s.status === 'running'));
  if (!doc || !size || !role || !visible) return null;
  const n = regions?.length ?? 0;
  const W = size.width;
  const H = size.height;
  return (
    <div className="pointer-events-none absolute left-0 top-0" style={{ width: W, height: H, zIndex: 16 }} data-testid="compare-highlights" data-count={n}>
      {!note &&
        regions?.map((r, i) => (
          <div
            key={i}
            className="cmp-mark absolute"
            data-testid="compare-mark"
            style={{ left: r.x * W, top: r.y * H, width: r.width * W, height: r.height * H }}
          >
            <span className="cmp-tag" style={{ fontSize: px(11), minWidth: px(18), height: px(18), lineHeight: px(18), top: px(-9), right: px(-9) }}>
              {i + 1}
            </span>
          </div>
        ))}
      {note && <div className="cmp-mark cmp-whole absolute inset-0" data-testid="compare-mark" />}
      {(done || note) && (
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
