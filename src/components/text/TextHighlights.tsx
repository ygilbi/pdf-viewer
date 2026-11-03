import { memo, useMemo } from 'react';
import { useViewer } from '../../state/store';
import { useSearch } from '../../text/searchStore';

const px = (n: number) => `calc(${n}px * var(--inv-zoom, 1))`;

/**
 * Search-hit boxes for the current page (page units, inside the transformed
 * world). Outline width is screen-constant via --inv-zoom.
 */
export const TextHighlights = memo(function TextHighlights({ page }: { page: number }) {
  const results = useSearch((s) => s.results);
  const active = useSearch((s) => s.results[s.activeIndex]);
  const size = useViewer((s) => s.pageSizes[page - 1]);
  const onPage = useMemo(() => results.filter((r) => r.page === page), [results, page]);
  if (!size || onPage.length === 0) return null;
  const pad = 1.5;
  return (
    <svg
      className="pointer-events-none absolute left-0 top-0"
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
      style={{ zIndex: 15, overflow: 'visible' }}
      data-testid="text-highlights"
      data-count={onPage.length}
    >
      {onPage.map((r, i) => {
        const isActive = r === active;
        return (
          <rect
            key={i}
            x={r.rect.x - pad}
            y={r.rect.y - pad}
            width={r.rect.width + 2 * pad}
            height={r.rect.height + 2 * pad}
            rx={1}
            fill={isActive ? 'rgba(249,115,22,0.30)' : 'rgba(250,204,21,0.35)'}
            stroke={isActive ? '#ea580c' : '#ca8a04'}
            style={{ strokeWidth: px(isActive ? 3 : 1.5) }}
            data-testid="text-hit"
          />
        );
      })}
    </svg>
  );
});
