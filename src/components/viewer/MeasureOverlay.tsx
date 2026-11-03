import { memo, useMemo, type ReactNode, type Ref } from 'react';
import type { AreaMeasurement, Calibration, Point, Rect, ToolId } from '../../core/types';
import {
  DEFAULT_STROKE_WIDTH,
  HIGHLIGHT_OPACITY,
  NOTE_PIN,
  arrowHeadSize,
  cloudPath,
  markupBounds,
  notePinPath,
  rectOfPoints,
  textLineBaselines,
} from '../../core/markupGeometry';
import {
  DEDUCT_COLOR,
  centroid,
  computeNetAreas,
  formatArea,
  formatLength,
  isMarkupKind,
  isSelfIntersecting,
  kindOf,
  polygonAreaM2,
  polylineLengthMeters,
  polylineMidpoint,
} from '../../core/measurementEngine';

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
const LENGTH_DRAFT = '#d97706';
const HATCH_ID = 'deduct-hatch';

const draftColor = (t: ToolId) => (t === 'calibrate' ? CALIB : t === 'deduct' || t === 'rectDeduct' ? DEDUCT_COLOR : t === 'length' ? LENGTH_DRAFT : DRAFT);

/** Screen-constant marker radius (px) for count items — keep in sync with ViewerCanvas VERTEX_PX. */
const MARKER_R = 9;

/** Isolate a signed number so RTL text doesn't move its minus sign to the end. */
const ltr = (s: string) => `\u2066${s}\u2069`;
const negArea = (m2: number) => `${ltr(`-${formatArea(m2).replace(/\s*מ״ר$/, '')}`)} מ״ר`;

/** Areas first, then openings, then lines → openings and lines paint on top. */
const KIND_ORDER = {
  area: 0,
  deduct: 1,
  length: 2,
  count: 3,
  // markup paints above the takeoff: fills first, then lines, then text / pins
  highlight: 4,
  rect: 5,
  cloud: 5,
  pen: 6,
  arrow: 6,
  text: 7,
  note: 8,
} as const;

export interface BandRefs {
  livePoly: Ref<SVGPolygonElement>;
  segment: Ref<SVGLineElement>;
  closing: Ref<SVGLineElement>;
  /** Live preview path of a markup shape being dragged out. */
  markup?: Ref<SVGPathElement>;
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

  // Live geometry (vertex drag) + paint order + net areas. Recomputed only when
  // measurement data changes — never on pan/zoom.
  const { ordered, nets } = useMemo(() => {
    const live = override
      ? measurements.map((m) => (m.id === override.id ? { ...m, points: override.points } : m))
      : measurements;
    const ordered = [...live].sort((a, b) => KIND_ORDER[kindOf(a)] - KIND_ORDER[kindOf(b)]);
    const nets = calibration ? computeNetAreas(live, { [live[0]?.page ?? 0]: calibration }) : null;
    return { ordered, nets };
  }, [measurements, override, calibration]);
  const dc = draftColor(tool);
  const polyTool = tool === 'area' || tool === 'deduct';

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="absolute left-0 top-0 overflow-visible"
      style={{ pointerEvents: 'none', zIndex: 20 }}
      data-testid="measure-overlay"
    >
      <defs>
        <pattern id={HATCH_ID} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
          <rect width={6} height={6} fill="#fff" fillOpacity={0.55} />
          <rect width={6} height={6} fill={DEDUCT_COLOR} fillOpacity={0.12} />
          <line x1={0} y1={0} x2={0} y2={6} stroke={DEDUCT_COLOR} strokeOpacity={0.75} strokeWidth={1.6} />
        </pattern>
      </defs>

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
      {ordered.map((m) => {
        const points = m.points;
        const kind = kindOf(m);
        const selected = m.id === selectedId;
        if (isMarkupKind(kind)) return <MarkupShape key={m.id} m={m} selected={selected} />;
        if (kind === 'count') {
          if (points.length === 0) return null;
          const first = points[0];
          return (
            <g key={m.id} data-measurement-id={m.id} data-kind="count" data-count={points.length}>
              {points.map((p, i) => (
                <g key={i} data-testid="count-marker">
                  {selected && (
                    <circle cx={p.x} cy={p.y} fill="none" stroke="#0f172a" style={{ r: px(MARKER_R + 2.5), strokeWidth: px(1.5) }} />
                  )}
                  <circle
                    cx={p.x}
                    cy={p.y}
                    fill={m.color}
                    fillOpacity={0.9}
                    stroke="#fff"
                    style={{ r: px(MARKER_R), strokeWidth: px(1.75) }}
                  />
                  <text
                    x={p.x}
                    y={p.y}
                    dy="0.35em"
                    textAnchor="middle"
                    fill="#fff"
                    fontWeight={700}
                    style={{ fontSize: px(i >= 99 ? 7.5 : 10), fontFamily: 'system-ui, Arial, sans-serif' }}
                  >
                    {i + 1}
                  </text>
                </g>
              ))}
              <text x={first.x} y={first.y} dy="-1.45em" textAnchor="middle" fill="#111827" style={labelStyle(12)}>
                <tspan fontWeight={600}>{m.label}</tspan>
                <tspan> {ltr(`×${points.length}`)}</tspan>
              </text>
            </g>
          );
        }
        if (points.length < 2) return null;
        const handles =
          selected &&
          points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} fill="#fff" stroke={m.color} style={{ r: px(5), strokeWidth: px(2) }} />
          ));

        if (kind === 'length') {
          const mid = polylineMidpoint(points);
          const len = ppm ? formatLength(polylineLengthMeters(points, ppm)) : null;
          return (
            <g key={m.id} data-measurement-id={m.id} data-kind="length">
              <polyline
                points={pts(points)}
                fill="none"
                stroke={m.color}
                strokeLinejoin="round"
                strokeLinecap="round"
                style={{ strokeWidth: px(selected ? 3 : 2.25) }}
              />
              {!selected &&
                [points[0], points[points.length - 1]].map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} fill={m.color} style={{ r: px(3) }} />
                ))}
              <text x={mid.x} y={mid.y} dy="-0.5em" textAnchor="middle" fill="#111827" style={labelStyle(12)}>
                <tspan fontWeight={600}>{m.label}</tspan>
                {len && <tspan> · {len}</tspan>}
              </text>
              {handles}
            </g>
          );
        }

        const bad = isSelfIntersecting(points);
        const c = centroid(points);
        const a = ppm ? polygonAreaM2(points, ppm) : null;
        const net = kind === 'area' ? nets?.get(m.id) : undefined;
        const lines: string[] = [];
        if (a !== null) lines.push(kind === 'deduct' ? negArea(a) : formatArea(a));
        if (net && net.deductIds.length) lines.push(`נטו ${formatArea(net.netM2)}`);
        const deduct = kind === 'deduct';
        return (
          <g key={m.id} data-measurement-id={m.id} data-kind={kind}>
            <polygon
              points={pts(points)}
              fill={deduct ? `url(#${HATCH_ID})` : m.color}
              fillOpacity={deduct ? 1 : selected ? 0.32 : 0.18}
              stroke={bad ? WARN : m.color}
              strokeLinejoin="round"
              style={{
                strokeWidth: px(selected ? 2.5 : deduct ? 1.5 : 1.75),
                strokeDasharray: bad ? `${px(6)} ${px(4)}` : undefined,
              }}
            />
            <text x={c.x} y={c.y} textAnchor="middle" fill={deduct ? '#9f1239' : '#111827'} style={labelStyle(deduct ? 11 : 13)}>
              <tspan x={c.x} dy={lines.length ? `${-0.15 - 0.625 * (lines.length - 1)}em` : '0.35em'} fontWeight={600}>
                {m.label}
              </tspan>
              {lines.map((t, i) => (
                <tspan key={i} x={c.x} dy="1.25em" fontWeight={i === 1 ? 600 : undefined}>
                  {t}
                </tspan>
              ))}
            </text>
            {handles}
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
              stroke={dc}
              strokeLinejoin="round"
              style={{ strokeWidth: px(2) }}
            />
          )}
          {draft.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              fill={i === 0 && polyTool && draft.length >= 3 ? '#fff' : dc}
              stroke={dc}
              style={{ r: px(i === 0 && polyTool && draft.length >= 3 ? 6 : 3.5), strokeWidth: px(2) }}
            />
          ))}
        </g>
      )}

      {/* rubber band — attributes updated imperatively */}
      <polygon
        ref={band.livePoly}
        points=""
        fill={dc}
        fillOpacity={0.12}
        stroke="none"
        visibility="hidden"
        data-testid="live-polygon"
      />
      <line
        ref={band.closing}
        stroke={dc}
        strokeOpacity={0.5}
        visibility="hidden"
        style={{ strokeWidth: px(1.25), strokeDasharray: `${px(4)} ${px(4)}` }}
      />
      {band.markup && (
        <path
          ref={band.markup}
          d=""
          visibility="hidden"
          strokeLinecap="round"
          strokeLinejoin="round"
          data-testid="live-markup"
        />
      )}
      <line
        ref={band.segment}
        stroke={dc}
        visibility="hidden"
        style={{ strokeWidth: px(2), strokeDasharray: `${px(6)} ${px(3)}` }}
      />
    </svg>
  );
}

export const MeasureOverlay = memo(MeasureOverlayImpl);

const SELECT_COLOR = '#0ea5e9';
const FONT = 'system-ui, "Segoe UI", Arial, sans-serif';

function SelectBox({ r }: { r: Rect }) {
  return (
    <rect
      x={r.x}
      y={r.y}
      width={Math.max(0, r.width)}
      height={Math.max(0, r.height)}
      fill="none"
      stroke={SELECT_COLOR}
      style={{ strokeWidth: px(1.25), strokeDasharray: `${px(5)} ${px(3)}`, outline: 'none' }}
      data-testid="markup-selection"
    />
  );
}

/** One markup / annotation (note, text, rect, cloud, arrow, pen, highlight). */
const MarkupShape = memo(function MarkupShape({ m, selected }: { m: AreaMeasurement; selected: boolean }) {
  const kind = kindOf(m);
  const pts = m.points;
  if (!pts.length) return null;
  const sw = m.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  const stroke = { strokeWidth: px(sw) };
  const handles =
    selected &&
    (kind === 'rect' || kind === 'cloud' || kind === 'highlight' || kind === 'arrow') &&
    pts.map((p, i) => (
      <circle key={i} cx={p.x} cy={p.y} fill="#fff" stroke={SELECT_COLOR} style={{ r: px(5), strokeWidth: px(2) }} />
    ));
  const g = (children: ReactNode) => (
    <g data-measurement-id={m.id} data-kind={kind} data-testid="markup" data-selected={selected ? 'true' : undefined}>
      {children}
      {handles}
    </g>
  );

  switch (kind) {
    case 'note': {
      const p = pts[0];
      return g(
        <g style={{ transform: `translate(${p.x}px, ${p.y}px) scale(var(--inv-zoom, 1))` }}>
          {selected && (
            <circle cx={0} cy={-NOTE_PIN.headY} r={NOTE_PIN.radius + 4} fill={SELECT_COLOR} fillOpacity={0.18} stroke={SELECT_COLOR} strokeWidth={1.5} />
          )}
          <path d={notePinPath({ x: 0, y: 0 })} fill={m.color} stroke="#fff" strokeWidth={1.75} style={{ filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.35))' }} />
          <path
            d={`M-5 ${-NOTE_PIN.headY - 3}h10M-5 ${-NOTE_PIN.headY + 1.5}h6`}
            stroke="#fff"
            strokeWidth={1.75}
            strokeLinecap="round"
            fill="none"
          />
        </g>,
      );
    }
    case 'text': {
      const fs = m.fontSize ?? 12;
      const lines = textLineBaselines(pts[0], m.text, fs);
      const empty = !(m.text ?? '').trim();
      return g(
        <>
          {!empty && (
            <text
              fill={m.color}
              fontSize={fs}
              textAnchor="start"
              style={{
                direction: 'rtl',
                fontFamily: FONT,
                fontWeight: 600,
                paintOrder: 'stroke',
                stroke: 'rgba(255,255,255,0.9)',
                strokeWidth: fs * 0.16,
                strokeLinejoin: 'round',
              }}
            >
              {lines.map((l, i) => (
                <tspan key={i} x={l.x} y={l.y}>
                  {l.text || '\u00a0'}
                </tspan>
              ))}
            </text>
          )}
          {(selected || empty) && <SelectBox r={markupBounds(m)} />}
        </>,
      );
    }
    case 'rect': {
      const r = rectOfPoints(pts);
      return g(
        <rect
          x={r.x}
          y={r.y}
          width={r.width}
          height={r.height}
          fill={m.color}
          fillOpacity={selected ? 0.08 : 0}
          stroke={m.color}
          strokeLinejoin="round"
          style={stroke}
        />,
      );
    }
    case 'cloud': {
      const r = rectOfPoints(pts);
      return g(
        <>
          <path d={cloudPath(r)} fill={m.color} fillOpacity={selected ? 0.08 : 0} stroke={m.color} strokeLinejoin="round" style={stroke} />
          {selected && <SelectBox r={r} />}
        </>,
      );
    }
    case 'highlight': {
      const r = rectOfPoints(pts);
      return g(
        <>
          <rect
            x={r.x}
            y={r.y}
            width={r.width}
            height={r.height}
            fill={m.color}
            fillOpacity={HIGHLIGHT_OPACITY}
            style={{ mixBlendMode: 'multiply' }}
          />
          {selected && <SelectBox r={r} />}
        </>,
      );
    }
    case 'pen':
      return g(
        <>
          <polyline points={pts.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke={m.color} strokeLinecap="round" strokeLinejoin="round" style={stroke} />
          {selected && <SelectBox r={markupBounds(m)} />}
        </>,
      );
    case 'arrow': {
      const a = pts[0];
      const b = pts[pts.length - 1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const L = arrowHeadSize(sw);
      const hw = L * Math.tan((25 * Math.PI) / 180);
      return g(
        <>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={m.color} strokeLinecap="round" style={stroke} />
          <g style={{ transform: `translate(${b.x}px, ${b.y}px) rotate(${ang}rad) scale(var(--inv-zoom, 1))` }}>
            <path d={`M${sw * 0.9} 0L${-L} ${hw}L${-L} ${-hw}Z`} fill={m.color} stroke={m.color} strokeLinejoin="round" strokeWidth={sw * 0.5} />
          </g>
        </>,
      );
    }
    default:
      return null;
  }
});
export const OVERLAY_WARN_COLOR = WARN;
