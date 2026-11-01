import { memo, type Ref } from 'react';
import type { AreaMeasurement, Calibration, Point, ToolId } from '../../core/types';
import { centroid, formatArea, formatLength, isSelfIntersecting, polygonAreaM2 } from '../../core/measurementEngine';

/**
 * Layer 3: SVG overlay in page units (viewBox = page), living inside the
 * transformed "world" element so it pans/zooms for free with the PDF layers.
 *
 * Screen-constant sizes (stroke widths, handle radii, font sizes, dashes) are
 * expressed as `calc(Npx * var(--inv-zoom))`; the viewport writes --inv-zoom
 * on the world element each frame, so zooming never re-renders React.
 * (We deliberately don't rely on `vector-effect: non-scaling-stroke`: it only
 * compensates the SVG's own CTM, not CSS transforms on HTML ancestors, so it
 * would have no effect here.)
 *
 * The rubber band (live segment to the cursor, live polygon preview) is NOT
 * rendered by React: its elements are exposed via refs and ViewerCanvas
 * updates their attributes directly on pointermove.
 */

export const px = (n: number) => `calc(${n}px * var(--inv-zoom, 1))`;

const WARN = '#dc2626';
const DRAFT = '#2563eb';
const CALIB = '#7c3aed';

export interface BandRefs {
  livePoly: Ref<SVGPolygonElement>;
  segment: Ref<SVGLineElement>;
  closing: Ref<SVGLineElement>;
}

interface Props {
  width: number;
  height: number;
  measurements: AreaMeasurement[];
  selectedId: string | null;
  calibration: Calibration | undefined;
  draft: Point[];
  tool: ToolId;
  /** Live geometry of a measurement whose vertex is being dragged. */
  override: { id: string; points: Point[] } | null;
  band: BandRefs;
}

const pts = (p: Point[]) => p.map((q) => `${q.x},${q.y}`).join(' ');

const labelStyle = (size: number) => ({
  fontSize: px(size),
  strokeWidth: px(3.5),
  paintOrder: 'stroke' as const,
  stroke: 'rgba(255,255,255,0.92)',
  strokeLinejoin: 'round' as const,
  direction: 'rtl' as const,
  fontFamily: 'system-ui, "Segoe UI", Arial, sans-serif',
});

function MeasureOverlayImpl({ width, height, measurements, selectedId, calibration, draft, tool, override, band }: Props) {
  const W = Math.ceil(width);
  const H = Math.ceil(height);
  const ppm = calibration?.pixelsPerMeter;

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="absolute left-0 top-0 overflow-visible"
      style={{ pointerEvents: 'none', zIndex: 20 }}
      data-testid="measure-overlay"
    >
      {/* existing calibration (faint) */}
      {calibration && (
        <g opacity={0.65}>
          <line
            x1={calibration.p1.x}
            y1={calibration.p1.y}
            x2={calibration.p2.x}
            y2={calibration.p2.y}
            stroke={CALIB}
            style={{ strokeWidth: px(1.5), strokeDasharray: `${px(6)} ${px(4)}` }}
          />
          {[calibration.p1, calibration.p2].map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} fill={CALIB} style={{ r: px(3) }} />
          ))}
          <text
            x={(calibration.p1.x + calibration.p2.x) / 2}
            y={(calibration.p1.y + calibration.p2.y) / 2}
            dy="-0.6em"
            textAnchor="middle"
            fill={CALIB}
            style={labelStyle(11)}
          >
            {formatLength(calibration.meters)}
          </text>
        </g>
      )}

      {/* measurements */}
      {measurements.map((m) => {
        const points = override && override.id === m.id ? override.points : m.points;
        if (points.length < 2) return null;
        const selected = m.id === selectedId;
        const bad = isSelfIntersecting(points);
        const c = centroid(points);
        const area = ppm ? formatArea(polygonAreaM2(points, ppm)) : null;
        return (
          <g key={m.id} data-measurement-id={m.id}>
            <polygon
              points={pts(points)}
              fill={m.color}
              fillOpacity={selected ? 0.32 : 0.18}
              stroke={bad ? WARN : m.color}
              strokeLinejoin="round"
              style={{
                strokeWidth: px(selected ? 2.5 : 1.75),
                strokeDasharray: bad ? `${px(6)} ${px(4)}` : undefined,
              }}
            />
            <text x={c.x} y={c.y} textAnchor="middle" fill="#111827" style={labelStyle(13)}>
              <tspan x={c.x} dy={area ? '-0.15em' : '0.35em'} fontWeight={600}>
                {m.label}
              </tspan>
              {area && (
                <tspan x={c.x} dy="1.25em">
                  {area}
                </tspan>
              )}
            </text>
            {selected &&
              points.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  fill="#fff"
                  stroke={m.color}
                  style={{ r: px(5), strokeWidth: px(2) }}
                />
              ))}
          </g>
        );
      })}

      {/* draft (points already placed) */}
      {draft.length > 0 && (
        <g>
          {draft.length > 1 && (
            <polyline
              points={pts(draft)}
              fill="none"
              stroke={tool === 'calibrate' ? CALIB : DRAFT}
              strokeLinejoin="round"
              style={{ strokeWidth: px(2) }}
            />
          )}
          {draft.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              fill={i === 0 && tool === 'area' && draft.length >= 3 ? '#fff' : tool === 'calibrate' ? CALIB : DRAFT}
              stroke={tool === 'calibrate' ? CALIB : DRAFT}
              style={{ r: px(i === 0 && tool === 'area' && draft.length >= 3 ? 6 : 3.5), strokeWidth: px(2) }}
            />
          ))}
        </g>
      )}

      {/* rubber band — attributes updated imperatively */}
      <polygon
        ref={band.livePoly}
        points=""
        fill={DRAFT}
        fillOpacity={0.12}
        stroke="none"
        visibility="hidden"
        data-testid="live-polygon"
      />
      <line
        ref={band.closing}
        stroke={DRAFT}
        strokeOpacity={0.5}
        visibility="hidden"
        style={{ strokeWidth: px(1.25), strokeDasharray: `${px(4)} ${px(4)}` }}
      />
      <line
        ref={band.segment}
        stroke={tool === 'calibrate' ? CALIB : DRAFT}
        visibility="hidden"
        style={{ strokeWidth: px(2), strokeDasharray: `${px(6)} ${px(3)}` }}
      />
    </svg>
  );
}

export const MeasureOverlay = memo(MeasureOverlayImpl);
export const OVERLAY_WARN_COLOR = WARN;
