import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewer } from '../state/store';
import { getPdfClient, getPageSnapGeometry } from '../core/pdfClient';
import { SNAP_INTERSECTION, SNAP_MIDPOINT, SnapIndex, nearestExtra, pickSnap, projectOnRay, type SnapHit } from '../core/snapIndex';
import { useSnap } from '../state/snapStore';
import type { AreaMeasurement, MarkupKind, MeasurementKind, Point, ToolId } from '../core/types';
import {
  DEDUCT_COLOR,
  KIND_LABEL_PREFIX,
  MEASUREMENT_COLORS,
  computePixelsPerMeter,
  distance,
  distanceToPolyline,
  formatArea,
  formatLength,
  isMarkupKind,
  isSelfIntersecting,
  lengthMeters,
  nearestVertex,
  kindOf,
  minPoints,
  newId,
  nextLabelNumber,
  parseLengthInput,
  pointInPolygon,
  polygonAreaM2,
  polylineLengthMeters,
  snapAngle,
} from '../core/measurementEngine';
import { ViewportController } from './viewer/Viewport';
import { PageLayers } from './viewer/TileLayer';
import { MeasureOverlay, OVERLAY_WARN_COLOR } from './viewer/MeasureOverlay';
import { emitZoom, registerViewer, takePendingFocus } from './viewer/commands';
import { TextHighlights } from './text/TextHighlights';
import { MarkupEditor, NoteBubbles } from './viewer/MarkupHtml';
import { useMarkup } from '../state/markupStore';
import {
  DEFAULT_STROKE_WIDTH,
  HIGHLIGHT_COLOR,
  MARKUP_COLOR,
  arrowHeadPath,
  arrowHeadSize,
  arrowShaftEnd,
  cloudPath,
  hitMarkup,
  normRect,
  polylinePath,
  rectPath,
  simplifyRDP,
  translatePoints,
} from '../core/markupGeometry';

/**
 * Main drawing viewport.
 *
 * Performance model:
 *  - View transform lives in ViewportController (refs, not React state) and is
 *    applied as a single CSS transform on the "world" element → pan/zoom is
 *    GPU compositing only. React renders only when *document data* changes
 *    (page, tool, draft points, measurements).
 *  - PDF rasters (base page bitmap + sharp region bitmaps) are managed
 *    imperatively by PageLayers; they re-render only when the view settles.
 *  - High-frequency pointer data (cursor position, rubber band) is written
 *    straight to DOM attributes.
 */

/** Debounce after the last view change before rendering the sharp layer. */
const SETTLE_MS = 50;
/** After a zoom animation's target changes (wheel notch / button), render the target view this soon. */
const TARGET_MS = 70;
/** While panning continuously at a fixed zoom, render the uncovered view at most this often. */
const PAN_RENDER_MS = 150;
const CLOSE_PX = 10; // close polygon when clicking this close to the first vertex
const VERTEX_PX = 9; // vertex-handle hit radius
const DRAG_PX_MOUSE = 4;
const DRAG_PX_TOUCH = 9;
const DBL_MS = 350;
const ZOOM_STEP = 1.5;
/** Geometry snap radius (screen px). */
const SNAP_PX = 10;

type Gesture =
  | { kind: 'none' }
  /** Left button down in a drawing tool: becomes a click, or a pan once it moves. */
  | { kind: 'pending'; id: number; sx: number; sy: number; threshold: number }
  | { kind: 'pan'; id: number; lx: number; ly: number; sx: number; sy: number; moved: boolean; clickOnUp: boolean }
  | { kind: 'vertex'; id: number; mid: string; index: number; points: Point[] }
  /** Drag-to-draw markup (rect / cloud / arrow / pen / highlight). */
  | { kind: 'draw'; id: number; tool: MarkupKind; pts: Point[]; sx: number; sy: number; lx: number; ly: number }
  /** Dragging a whole markup annotation (pan tool). */
  | { kind: 'move'; id: number; mid: string; sx: number; sy: number; orig: Point[]; points: Point[]; moved: boolean }
  | { kind: 'pinch'; a: number; b: number; dist: number; mx: number; my: number }
  /** Rectangle area / opening by dragging (rectArea tool, or Alt + deduct). */
  | { kind: 'rect'; id: number; a: Point; mk: 'area' | 'deduct'; sx: number; sy: number; moved: boolean; threshold: number };

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

const LINE_HIT_PX = 7; // pan-tool hit radius around a length polyline

/** Drawing tool → kind of measurement it creates (null for pan / calibrate). */
function toolKind(t: ToolId): MeasurementKind | null {
  if (t === 'rectArea') return 'area';
  return t === 'area' || t === 'deduct' || t === 'length' ? t : null;
}
/** Tools whose clicks snap to the drawing's vector geometry. */
const isSnapTool = (t: ToolId) =>
  t === 'area' || t === 'deduct' || t === 'length' || t === 'calibrate' || t === 'rectArea' || t === 'count';
/** Rectangle from two opposite corners (clockwise on screen). */
const rectCorners = (a: Point, b: Point): Point[] => [
  { x: a.x, y: a.y },
  { x: b.x, y: a.y },
  { x: b.x, y: b.y },
  { x: a.x, y: b.y },
];
const isPolygonTool = (t: ToolId) => t === 'area' || t === 'deduct';
/** Markup tools drawn by dragging. */
const isDragTool = (t: ToolId): t is MarkupKind =>
  t === 'rect' || t === 'cloud' || t === 'arrow' || t === 'pen' || t === 'highlight';
/** Markup kinds without vertex handles (moved as a whole only). */
const noHandles = (m: AreaMeasurement) => {
  const k = kindOf(m);
  return k === 'pen' || k === 'note' || k === 'text';
};
/** Minimum drag (screen px) for a drawn markup shape to count. */
const MIN_DRAW_PX = 4;
/** Default 'text' size on screen at the zoom it is placed at (then scales with the drawing). */
const TEXT_SCREEN_PX = 16;

type StoreState = ReturnType<typeof useViewer.getState>;

/** Color + category for a new measurement: follows the active category (openings stay red-hatched). */
function newMeasurementStyle(s: StoreState, kind: MeasurementKind | MarkupKind): Pick<AreaMeasurement, 'color' | 'category'> {
  const cat = s.activeCategoryId ? s.categories.find((c) => c.id === s.activeCategoryId) : undefined;
  if (isMarkupKind(kind)) {
    const picked = useMarkup.getState().color;
    const color = picked ?? (kind === 'highlight' ? HIGHLIGHT_COLOR : (cat?.color ?? MARKUP_COLOR));
    return cat ? { color, category: cat.id } : { color };
  }
  const color =
    kind === 'deduct'
      ? DEDUCT_COLOR
      : (cat?.color ?? MEASUREMENT_COLORS[s.measurements.length % MEASUREMENT_COLORS.length]);
  return cat ? { color, category: cat.id } : { color };
}

/** The selected measurement if it is a count group on the current page. */
function activeCount(s: StoreState): AreaMeasurement | undefined {
  if (!s.selectedId) return undefined;
  return s.measurements.find((m) => m.id === s.selectedId && m.page === s.currentPage && kindOf(m) === 'count');
}

/** Remove one marker from a count group (the group itself goes when it becomes empty). */
function removeMarker(s: StoreState, m: AreaMeasurement, index: number) {
  const points = m.points.filter((_, i) => i !== index);
  if (points.length === 0) s.removeMeasurement(m.id);
  else s.updateMeasurement(m.id, { points });
}

/** Rubber-band colour per tool (keep in sync with MeasureOverlay's draft colours). */
function toolColor(t: ToolId, bad = false): string {
  if (bad) return OVERLAY_WARN_COLOR;
  if (t === 'calibrate') return '#7c3aed';
  if (t === 'deduct') return DEDUCT_COLOR;
  if (t === 'length') return '#d97706';
  return '#2563eb';
}

/** Topmost markup under a page point (notes, then text, then shapes). */
function hitMarkupAt(p: Point, ms: AreaMeasurement[], page: number, zoom: number, kinds?: MarkupKind[]): AreaMeasurement | undefined {
  const onPage = ms.filter((m) => m.page === page && isMarkupKind(m.kind) && (!kinds || kinds.includes(m.kind as MarkupKind))).reverse();
  const slop = LINE_HIT_PX / zoom;
  const hit = (m: AreaMeasurement) => hitMarkup(p, m, slop, 1 / zoom);
  return (
    onPage.find((m) => m.kind === 'note' && hit(m)) ??
    onPage.find((m) => m.kind === 'text' && hit(m)) ??
    onPage.find((m) => m.kind !== 'highlight' && hit(m)) ??
    onPage.find((m) => hit(m))
  );
}

/** Topmost measurement under a page point: markup, count markers, then lines, openings, areas. */
function hitTest(
  p: Point,
  ms: AreaMeasurement[],
  page: number,
  lineSlop: number,
  markerSlop: number,
  zoom: number,
): AreaMeasurement | undefined {
  const onPage = ms.filter((m) => m.page === page).reverse();
  return (
    hitMarkupAt(p, ms, page, zoom) ??
    onPage.find((m) => kindOf(m) === 'count' && nearestVertex(p, m.points, markerSlop) >= 0) ??
    onPage.find((m) => kindOf(m) === 'length' && distanceToPolyline(p, m.points) <= lineSlop) ??
    onPage.find((m) => kindOf(m) === 'deduct' && pointInPolygon(p, m.points)) ??
    onPage.find((m) => kindOf(m) === 'area' && pointInPolygon(p, m.points))
  );
}

export default function ViewerCanvas() {
  const numPages = useViewer((s) => s.numPages);
  const pageSizes = useViewer((s) => s.pageSizes);
  const docs = useViewer((s) => s.docs);
  const fileName = useViewer((s) => s.fileName);
  const currentPage = useViewer((s) => s.currentPage);
  const tool = useViewer((s) => s.tool);
  const draft = useViewer((s) => s.draft);
  const calibrations = useViewer((s) => s.calibrations);
  const measurements = useViewer((s) => s.measurements);
  const selectedId = useViewer((s) => s.selectedId);
  const editingId = useMarkup((s) => s.editingId);
  const snapOn = useSnap((s) => s.enabled);

  const size = numPages > 0 ? pageSizes[currentPage - 1] : undefined;
  const calibration = calibrations[currentPage];
  const pageMeasurements = useMemo(() => measurements.filter((m) => m.page === currentPage), [measurements, currentPage]);
  const pageNotes = useMemo(() => pageMeasurements.filter((m) => m.kind === 'note'), [pageMeasurements]);
  const editing = editingId ? pageMeasurements.find((m) => m.id === editingId) : undefined;

  const [override, setOverride] = useState<{ id: string; points: Point[] } | null>(null);

  const [vp] = useState(() => new ViewportController());
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const tilesRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const livePolyRef = useRef<SVGPolygonElement>(null);
  const segmentRef = useRef<SVGLineElement>(null);
  const closingRef = useRef<SVGLineElement>(null);
  const markupRef = useRef<SVGPathElement>(null);
  const snapMarkerRef = useRef<SVGSVGElement>(null);
  const layersRef = useRef<PageLayers | null>(null);
  /** Imperative hooks the main effect installs, so React effects can poke them. */
  const hooks = useRef({ updateBand: () => {}, updateCursor: () => {} });

  const band = useMemo(() => ({ livePoly: livePolyRef, segment: segmentRef, closing: closingRef, markup: markupRef }), []);

  // ---------------------------------------------------------------------------
  // Mount: viewport, raster layers, commands, input handling.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current!;
    const world = worldRef.current!;
    const layers = new PageLayers(getPdfClient(), baseRef.current!, tilesRef.current!);
    layersRef.current = layers;
    vp.setWorld(world);

    let rect = container.getBoundingClientRect();
    let gesture: Gesture = { kind: 'none' };
    const pointers = new Map<number, { x: number; y: number; type: string }>();
    let cursor: { x: number; y: number } | null = null; // screen px, container-relative
    let shift = false;
    let space = false;
    let lastClick: { t: number; x: number; y: number } | null = null;
    let lastMiddle = 0;
    let settleTimer = 0;
    let lastViewKey = '';
    let overrideFrame = 0;
    let pendingOverride: { id: string; points: Point[] } | null = null;
    let interacting = false;
    /** Markup under the mouse (pan tool cursor + note hover bubble). */
    let hoverId: string | null = null;
    let lastMarkupClick: { t: number; id: string } | null = null;
    // ---- geometry snap state ----
    let ctrl = false;
    let alt = false;
    /** The current 1-point draft is the first corner of a rectangle (rectArea, or Alt + deduct). */
    let rectMode = false;
    let snapHit: SnapHit | null = null;
    let snapKey = '';
    let snapIndex: SnapIndex | null = null;
    let extraKey: { ms: unknown; page: number; draft: unknown; skip: string | null } | null = null;
    let extraPts: Point[] = [];

    const local = (e: { clientX: number; clientY: number }) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const st = () => useViewer.getState();

    // ---- view change → zoom readout, stale-render cancel, debounce sharp ----
    let targetTimer = 0;
    let lastTargetKey = '';
    let lastFrameZoom = 0;
    let lastPanRender = 0;
    let panSample: { t: number; x: number; y: number } | null = null;
    const settle = () => {
      settleTimer = 0;
      if (vp.isAnimating()) {
        settleTimer = window.setTimeout(settle, SETTLE_MS);
        return;
      }
      lastPanRender = performance.now();
      layers.settle(vp.zoom, vp.visibleRect());
      if (interacting) {
        // Let the browser re-rasterise the vector overlay crisply at the final scale.
        world.style.willChange = 'auto';
        interacting = false;
      }
    };
    const unsubscribe = vp.subscribe(() => {
      emitZoom(vp.zoom, vp.fitZoom, vp.minZoom, vp.maxZoom);
      const key = `${vp.zoom}|${vp.panX}|${vp.panY}|${vp.cw}|${vp.ch}`;
      if (key === lastViewKey) return;
      lastViewKey = key;
      if (!interacting) {
        world.style.willChange = 'transform';
        interacting = true;
      }
      const target = vp.targetView();
      layers.viewChanged(vp.zoom, vp.visibleRect(), target);
      updateBand();
      clearTimeout(settleTimer);
      settleTimer = window.setTimeout(settle, SETTLE_MS);
      if (target) {
        // Start the sharp render for where the animation will END while it plays.
        // Rounded: the target pan is recomputed every frame (float noise must not reset the timer).
        const tk = `${target.zoom.toPrecision(6)}|${target.visible.x.toFixed(1)}|${target.visible.y.toFixed(1)}`;
        if (tk !== lastTargetKey) {
          lastTargetKey = tk;
          clearTimeout(targetTimer);
          targetTimer = window.setTimeout(() => {
            targetTimer = 0;
            const t = vp.targetView();
            if (t) layers.settle(t.zoom, t.visible);
          }, TARGET_MS);
        }
      } else {
        lastTargetKey = '';
        // Slow continuous pan at a fixed zoom: don't wait for the pan to stop.
        // Only when slow (< 1/4 viewport per PAN_RENDER_MS): during a fast pan
        // the result would be stale on arrival, and uploading big bitmaps
        // mid-motion costs frames.
        const now = performance.now();
        if (vp.zoom !== lastFrameZoom) panSample = null;
        else if (!panSample) panSample = { t: now, x: vp.panX, y: vp.panY };
        else if (now - panSample.t >= PAN_RENDER_MS) {
          const moved = Math.hypot(vp.panX - panSample.x, vp.panY - panSample.y);
          panSample = { t: now, x: vp.panX, y: vp.panY };
          if (moved < Math.min(vp.cw, vp.ch) / 4 && now - lastPanRender >= PAN_RENDER_MS && !layers.isSharp(vp.zoom, vp.visibleRect())) {
            lastPanRender = now;
            layers.settle(vp.zoom, vp.visibleRect());
          }
        }
      }
      lastFrameZoom = vp.zoom;
    });

    registerViewer({
      fit: () => vp.fit(true),
      zoomIn: () => vp.zoomBy(ZOOM_STEP),
      zoomOut: () => vp.zoomBy(1 / ZOOM_STEP),
      zoomToScale: (z) => vp.zoomToAnimated(z),
      zoomToRect: (r) => vp.zoomToRect(r),
    });

    // ---- rubber band + readout (direct DOM writes) --------------------------
    // ---- geometry snap -----------------------------------------------------
    /** Load (once per page + layout) the page's snap points from the worker and index them. */
    const ensureSnapIndex = () => {
      const s = st();
      if (s.numPages === 0) return;
      const key = `${s.currentPage}|${s.docs.map((d) => d.id).join(',')}`;
      if (key === snapKey) return;
      snapKey = key;
      snapIndex = null;
      const t0 = performance.now();
      getPageSnapGeometry(s.currentPage).then(
        (g) => {
          if (snapKey !== key) return;
          const t1 = performance.now();
          snapIndex = new SnapIndex(g.xy, g.kind, g.count);
          const stats = {
            page: s.currentPage,
            points: g.count,
            segments: g.segments,
            truncated: g.truncated,
            workerMs: Math.round(g.ms * 10) / 10,
            extractMs: Math.round(g.extractMs * 10) / 10,
            roundTripMs: Math.round((t1 - t0) * 10) / 10,
            indexMs: Math.round((performance.now() - t1) * 10) / 10,
          };
          (window as unknown as { __snapStats?: unknown }).__snapStats = stats;
          updateBand();
        },
        () => {
          if (snapKey === key) snapKey = ''; // retry next time
        },
      );
    };
    const snapWanted = (tool: ToolId) => useSnap.getState().enabled && !ctrl && isSnapTool(tool);
    /** Existing takeoff vertices on the page (+ the draft) as extra endpoints. */
    const extras = (skipId: string | null): Point[] => {
      const s = st();
      if (!extraKey || extraKey.ms !== s.measurements || extraKey.page !== s.currentPage || extraKey.draft !== s.draft || extraKey.skip !== skipId) {
        extraKey = { ms: s.measurements, page: s.currentPage, draft: s.draft, skip: skipId };
        extraPts = [...s.draft];
        for (const m of s.measurements) {
          if (m.page !== s.currentPage || m.id === skipId || isMarkupKind(m.kind)) continue;
          for (const q of m.points) extraPts.push(q);
        }
        const c = s.calibrations[s.currentPage];
        if (c && !c.auto) extraPts.push(c.p1, c.p2);
      }
      return extraPts;
    };
    const findSnap = (p: Point, skipId: string | null = null): SnapHit | null => {
      ensureSnapIndex();
      const r = SNAP_PX / vp.zoom;
      return pickSnap(snapIndex?.nearest(p, r) ?? null, nearestExtra(p, extras(skipId), r));
    };
    /**
     * Raw page point → final point: Shift = 45° angle lock from the last draft
     * point; geometry snap (unless off / Ctrl) to the nearest endpoint,
     * intersection or midpoint within SNAP_PX. With both, the snap point is
     * projected onto the locked direction. Sets `snapHit` (marker).
     */
    const resolvePoint = (raw: Point, anchor: Point | null, tool: ToolId, skipId: string | null = null): Point => {
      const ortho = shift && anchor !== null;
      let p = ortho ? snapAngle(anchor!, raw, 45) : raw;
      snapHit = null;
      if (snapWanted(tool)) {
        const hit = findSnap(p, skipId);
        if (hit) {
          snapHit = hit;
          p = ortho ? projectOnRay(anchor!, p, hit) : { x: hit.x, y: hit.y };
        }
      }
      return p;
    };
    /** Anchor for the angle lock (none for a rectangle's 2nd corner). */
    const drawAnchor = (): Point | null => {
      const d = st().draft;
      if (gesture.kind === 'rect' || (rectMode && d.length === 1)) return null;
      return d.length > 0 ? d[d.length - 1] : null;
    };
    const cursorPage = (): Point | null => {
      if (!cursor) return null;
      return resolvePoint(vp.toPage(cursor.x, cursor.y), drawAnchor(), st().tool);
    };
    const updateMarker = (on: boolean) => {
      const el = snapMarkerRef.current;
      if (!el) return;
      if (!on || !snapHit) {
        if (el.style.display !== 'none') el.style.display = 'none';
        return;
      }
      const q = vp.toScreen(snapHit);
      const kind = snapHit.kind === SNAP_MIDPOINT ? 'mid' : snapHit.kind === SNAP_INTERSECTION ? 'x' : 'end';
      if (el.dataset.kind !== kind) el.dataset.kind = kind;
      el.style.display = 'block';
      el.style.transform = `translate3d(${q.x - 8}px, ${q.y - 8}px, 0)`;
    };
    /** Rectangle preview (rect drag or 2nd corner pending) on the live markup path. */
    const rectAnchor = (): { a: Point; mk: 'area' | 'deduct' } | null => {
      if (gesture.kind === 'rect') return gesture.moved ? { a: gesture.a, mk: gesture.mk } : null;
      const s = st();
      if (rectMode && s.draft.length === 1 && gesture.kind === 'none') return { a: s.draft[0], mk: s.tool === 'deduct' ? 'deduct' : 'area' };
      return null;
    };

    const show = (el: Element | null, on: boolean) => {
      const v = on ? 'visible' : 'hidden';
      if (el && el.getAttribute('visibility') !== v) el.setAttribute('visibility', v);
    };

    const updateBand = () => {
      const s = st();
      const seg = segmentRef.current;
      const poly = livePolyRef.current;
      const closing = closingRef.current;
      const readout = readoutRef.current;
      const p = cursorPage();
      const drawing =
        s.numPages > 0 &&
        (toolKind(s.tool) !== null ||
          s.tool === 'count' ||
          isMarkupKind(s.tool) ||
          (s.tool === 'calibrate' && s.draft.length < 2));
      const polyTool = isPolygonTool(s.tool);
      const active =
        drawing &&
        p !== null &&
        gesture.kind !== 'pan' &&
        gesture.kind !== 'pinch' &&
        gesture.kind !== 'vertex' &&
        gesture.kind !== 'draw' &&
        gesture.kind !== 'move' &&
        !useMarkup.getState().editingId;
      const d = s.draft;
      const ppm = s.calibrations[s.currentPage]?.pixelsPerMeter;
      // Prefetch the page's snap geometry as soon as a snapping tool is active (not on the first click).
      if (drawing && snapWanted(s.tool)) ensureSnapIndex();
      const ra = drawing && p ? rectAnchor() : null;
      updateMarker((active || gesture.kind === 'rect') && p !== null);
      if (gesture.kind !== 'draw') {
        const el = markupRef.current;
        if (el && ra && p) {
          const col = ra.mk === 'deduct' ? DEDUCT_COLOR : '#2563eb';
          el.setAttribute('d', rectPath(normRect(ra.a, p)));
          el.setAttribute('stroke', col);
          el.setAttribute('fill', col);
          el.setAttribute('fill-opacity', '0.12');
          el.style.strokeWidth = 'calc(2px * var(--inv-zoom, 1))';
          el.setAttribute('visibility', 'visible');
        } else if (el && el.getAttribute('visibility') !== 'hidden') {
          el.setAttribute('visibility', 'hidden');
          el.setAttribute('d', '');
        }
      }

      if (seg) {
        const on = active && d.length > 0 && !ra && !(rectMode && d.length === 1);
        show(seg, on);
        if (on && p) {
          const a = d[d.length - 1];
          seg.setAttribute('x1', String(a.x));
          seg.setAttribute('y1', String(a.y));
          seg.setAttribute('x2', String(p.x));
          seg.setAttribute('y2', String(p.y));
        }
      }
      let bad = false;
      let nearFirst = false;
      if (poly && closing) {
        const on = active && polyTool && d.length >= 2 && !rectMode;
        show(poly, on);
        show(closing, on);
        if (on && p) {
          const all = [...d, p];
          bad = isSelfIntersecting(all);
          poly.setAttribute('points', all.map((q) => `${q.x},${q.y}`).join(' '));
          poly.setAttribute('fill', toolColor(s.tool, bad));
          closing.setAttribute('x1', String(p.x));
          closing.setAttribute('y1', String(p.y));
          closing.setAttribute('x2', String(d[0].x));
          closing.setAttribute('y2', String(d[0].y));
        }
        const stroke = toolColor(s.tool, bad);
        if (seg && seg.getAttribute('stroke') !== stroke) seg.setAttribute('stroke', stroke);
      }
      if (p && polyTool && d.length >= 3) nearFirst = distance(p, d[0]) * vp.zoom <= CLOSE_PX;

      if (readout) {
        let text = '';
        let warn = false;
        if ((active || ra) && p && (ra || s.tool === 'rectArea' || (rectMode && d.length === 1))) {
          if (!ra) text = s.tool === 'deduct' ? 'פתח מלבני: לחץ על הפינה הראשונה' : 'לחץ על פינה ראשונה (או גרור)';
          else if (!ppm) {
            text = 'יש לכייל קנה מידה';
            warn = true;
          } else {
            const w = Math.abs(p.x - ra.a.x) / ppm;
            const h = Math.abs(p.y - ra.a.y) / ppm;
            text = `\u2066${w.toFixed(2)} × ${h.toFixed(2)}\u2069 מ׳ · ${ra.mk === 'deduct' ? 'פתח: ' : ''}${formatArea(w * h)}`;
          }
        } else if (active && p) {
          if (s.tool === 'note') text = 'לחץ להוספת הערה';
          else if (s.tool === 'text') text = 'לחץ להוספת טקסט';
          else if (s.tool === 'arrow') text = 'גרור מהזנב לראש החץ';
          else if (s.tool === 'pen') text = 'גרור לציור חופשי';
          else if (isDragTool(s.tool)) text = 'גרור לציור';
          else if (s.tool === 'count') {
            const g = activeCount(s);
            text = g
              ? `${g.label} ×${g.points.length} · לחץ להוספה · Enter לסיום`
              : 'לחץ לסימון פריט (קבוצת ספירה חדשה)';
          } else if (s.tool === 'length') {
            if (!ppm) {
              text = 'יש לכייל קנה מידה';
              warn = true;
            } else if (d.length === 0) text = 'לחץ על נקודת ההתחלה';
            else {
              text = formatLength(polylineLengthMeters([...d, p], ppm));
              if (d.length >= 2) text += ' · לחיצה כפולה / Enter לסיום';
            }
          } else if (polyTool) {
            if (!ppm) {
              text = 'יש לכייל קנה מידה';
              warn = true;
            } else if (d.length >= 2) {
              const a = polygonAreaM2([...d, p], ppm);
              text = s.tool === 'deduct' ? `פתח: ${formatArea(a)}` : formatArea(a);
            } else if (d.length === 0) {
              text = 'לחץ להוספת נקודה';
            }
            if (nearFirst) text = text ? `${text} · לחץ לסגירה` : 'לחץ לסגירה';
            if (bad) {
              text = `${text} · מצולע חותך את עצמו`;
              warn = true;
            }
          } else if (s.tool === 'calibrate') {
            if (d.length === 0) text = 'לחץ על נקודת ההתחלה';
            else text = ppm ? `${formatLength(lengthMeters(d[d.length - 1], p, ppm))} · לחץ על נקודת הסיום` : 'לחץ על נקודת הסיום';
          }
        }
        if (snapHit && text && (active || ra)) text += snapHit.kind === SNAP_MIDPOINT ? ' · אמצע' : snapHit.kind === SNAP_INTERSECTION ? ' · חיתוך' : ' · קצה';
        if (text && cursor) {
          readout.textContent = text;
          readout.style.display = 'block';
          readout.style.color = warn ? OVERLAY_WARN_COLOR : '';
          const x = Math.min(cursor.x + 16, rect.width - readout.offsetWidth - 4);
          const y = Math.min(cursor.y + 18, rect.height - 28);
          readout.style.transform = `translate3d(${Math.max(4, x)}px, ${y}px, 0)`;
        } else readout.style.display = 'none';
      }
    };

    // ---- cursor style -------------------------------------------------------
    const hoverVertex = (): boolean => {
      if (!cursor) return false;
      const s = st();
      if (s.draft.length || !s.selectedId) return false;
      const m = s.measurements.find((x) => x.id === s.selectedId && x.page === s.currentPage);
      return !!m && !noHandles(m) && nearestVertex(vp.toPage(cursor.x, cursor.y), m.points, VERTEX_PX / vp.zoom) >= 0;
    };
    /** Track the markup under the mouse: pan-tool cursor + note comment bubble on hover. */
    const updateHover = () => {
      const s = st();
      const m = cursor && s.numPages > 0 ? hitMarkupAt(vp.toPage(cursor.x, cursor.y), s.measurements, s.currentPage, vp.zoom) : undefined;
      const id = m ? m.id : null;
      if (id === hoverId) return;
      if (hoverId) world.querySelector(`[data-note-bubble="${CSS.escape(hoverId)}"]`)?.removeAttribute('data-hover');
      hoverId = id;
      if (id && m?.kind === 'note') world.querySelector(`[data-note-bubble="${CSS.escape(id)}"]`)?.setAttribute('data-hover', '');
    };
    /** Live preview of a markup being dragged out (direct DOM writes, no React). */
    const updateLive = (g: Extract<Gesture, { kind: 'draw' }> | null) => {
      const el = markupRef.current;
      if (!el) return;
      if (!g) {
        el.setAttribute('visibility', 'hidden');
        el.setAttribute('d', '');
        return;
      }
      const a = g.pts[0];
      const b = g.pts[g.pts.length - 1];
      let d = '';
      if (g.tool === 'pen') d = polylinePath(g.pts);
      else if (g.tool === 'arrow') {
        const size = arrowHeadSize(useMarkup.getState().strokeWidth) / vp.zoom;
        const end = arrowShaftEnd(a, b, size);
        d = `M${a.x} ${a.y}L${end.x} ${end.y}` + arrowHeadPath(a, b, size);
      } else if (g.tool === 'cloud') d = cloudPath(normRect(a, b));
      else d = rectPath(normRect(a, b));
      el.setAttribute('d', d);
      el.setAttribute('visibility', 'visible');
    };
    const updateCursor = () => {
      let c: string;
      const tl = st().tool;
      if (gesture.kind === 'pan' && (gesture.moved || tl === 'pan')) c = 'grabbing';
      else if (gesture.kind === 'vertex' || gesture.kind === 'move') c = 'move';
      else if (gesture.kind === 'draw' || gesture.kind === 'rect') c = 'crosshair';
      else if (space) c = 'grab';
      else if (hoverVertex()) c = 'move';
      else if (tl === 'pan' && hoverId) c = 'move';
      else if ((tl === 'note' || tl === 'text') && hoverId) c = 'pointer';
      else c = tl === 'pan' ? 'grab' : 'crosshair';
      if (container.style.cursor !== c) container.style.cursor = c;
    };
    hooks.current = { updateBand, updateCursor };

    // ---- actions ------------------------------------------------------------
    const finishDraft = () => {
      const s = st();
      const kind = toolKind(s.tool);
      if (!kind) return;
      const pts: Point[] = [];
      for (const p of s.draft) {
        if (!pts.length || distance(pts[pts.length - 1], p) * vp.zoom > 0.5) pts.push(p);
      }
      if (kind !== 'length' && pts.length > 1 && distance(pts[0], pts[pts.length - 1]) * vp.zoom <= 0.5) pts.pop();
      if (pts.length < minPoints(kind)) return;
      s.addMeasurement({
        id: newId(),
        page: s.currentPage,
        kind,
        label: `${KIND_LABEL_PREFIX[kind]} ${nextLabelNumber(s.measurements, kind)}`,
        points: pts,
        ...newMeasurementStyle(s, kind),
      });
      s.setDraft([]);
    };

    /** Create a rectangle area / opening from two corners (ignored when too small on screen). */
    const finishRect = (a: Point, b: Point, mk: 'area' | 'deduct') => {
      const s = st();
      rectMode = false;
      if (Math.abs(b.x - a.x) * vp.zoom < MIN_DRAW_PX || Math.abs(b.y - a.y) * vp.zoom < MIN_DRAW_PX) {
        if (s.draft.length) s.setDraft([]);
        return;
      }
      s.addMeasurement({
        id: newId(),
        page: s.currentPage,
        kind: mk,
        label: `${KIND_LABEL_PREFIX[mk]} ${nextLabelNumber(s.measurements, mk)}`,
        points: rectCorners(a, b),
        ...newMeasurementStyle(s, mk),
      });
      if (s.draft.length) s.setDraft([]);
    };

    const click = (sx: number, sy: number) => {
      const s = st();
      if (s.numPages === 0) return;
      const raw = vp.toPage(sx, sy);
      if (s.tool === 'rectArea' || (s.tool === 'deduct' && ((alt && s.draft.length === 0) || (rectMode && s.draft.length === 1)))) {
        const mk = s.tool === 'deduct' ? 'deduct' : 'area';
        const d0 = s.draft;
        if (d0.length === 0 || !rectMode) {
          rectMode = true;
          if (s.selectedId) s.select(null);
          s.setDraft([resolvePoint(raw, null, s.tool)]);
        } else finishRect(d0[0], resolvePoint(raw, null, s.tool), mk);
        return;
      }
      rectMode = false;
      if (s.tool === 'pan') {
        const hit = hitTest(raw, s.measurements, s.currentPage, LINE_HIT_PX / vp.zoom, VERTEX_PX / vp.zoom, vp.zoom);
        s.select(hit ? hit.id : null);
        return;
      }
      if (s.tool === 'note' || s.tool === 'text') {
        // Clicking an existing note / text edits it; elsewhere places a new one.
        const hit = hitMarkupAt(raw, s.measurements, s.currentPage, vp.zoom, ['note', 'text']);
        if (hit) {
          s.select(hit.id);
          useMarkup.getState().startEditing(hit.id);
          return;
        }
        const kind = s.tool;
        const id = newId();
        const ms = useMarkup.getState();
        s.addMeasurement({
          id,
          page: s.currentPage,
          kind,
          label: `${KIND_LABEL_PREFIX[kind]} ${nextLabelNumber(s.measurements, kind)}`,
          points: [raw],
          text: '',
          ...(kind === 'text'
            ? { fontSize: Math.round(Math.min(400, Math.max(1, TEXT_SCREEN_PX / vp.zoom)) * 10) / 10 }
            : {}),
          ...(ms.strokeWidth !== DEFAULT_STROKE_WIDTH ? { strokeWidth: ms.strokeWidth } : {}),
          ...newMeasurementStyle(s, kind),
        });
        ms.startEditing(id, true);
        return;
      }
      if (s.tool === 'count') {
        // Add a marker to the active (selected) count group, or start a new group.
        const g = activeCount(s);
        const cp = resolvePoint(raw, null, 'count');
        if (g) s.updateMeasurement(g.id, { points: [...g.points, cp] });
        else {
          s.addMeasurement({
            id: newId(),
            page: s.currentPage,
            kind: 'count',
            label: `${KIND_LABEL_PREFIX.count} ${nextLabelNumber(s.measurements, 'count')}`,
            points: [cp],
            ...newMeasurementStyle(s, 'count'),
          });
        }
        return;
      }
      const d = s.draft;
      const p = resolvePoint(raw, d.length ? d[d.length - 1] : null, s.tool);
      if (s.tool === 'calibrate') {
        if (d.length >= 2) return;
        s.setDraft([...d, p]);
        return;
      }
      // area / deduct / length
      const kind = toolKind(s.tool)!;
      const now = performance.now();
      const dbl = lastClick && now - lastClick.t < DBL_MS && Math.hypot(sx - lastClick.x, sy - lastClick.y) < 6;
      lastClick = dbl ? null : { t: now, x: sx, y: sy };
      if (dbl) {
        if (d.length >= minPoints(kind)) finishDraft();
        return;
      }
      if (kind !== 'length' && d.length >= 3 && (distance(raw, d[0]) * vp.zoom <= CLOSE_PX || distance(p, d[0]) * vp.zoom <= 0.5)) {
        finishDraft();
        return;
      }
      if (s.selectedId) s.select(null);
      s.setDraft([...d, p]);
    };

    /** Finish a drag-to-draw gesture: create the markup if it is big enough. */
    const finishDraw = (g: Extract<Gesture, { kind: 'draw' }>) => {
      updateLive(null);
      const s = st();
      const a = g.pts[0];
      const b = g.pts[g.pts.length - 1];
      let points: Point[];
      if (g.tool === 'pen') {
        points = simplifyRDP(g.pts, 0.75 / vp.zoom);
        let len = 0;
        for (let i = 1; i < g.pts.length; i++) len += distance(g.pts[i - 1], g.pts[i]);
        if (len * vp.zoom < MIN_DRAW_PX) return;
        if (points.length < 2) points = [a, b];
      } else {
        const r = normRect(a, b);
        const big =
          g.tool === 'arrow'
            ? distance(a, b) * vp.zoom >= MIN_DRAW_PX * 2
            : r.width * vp.zoom >= MIN_DRAW_PX && r.height * vp.zoom >= MIN_DRAW_PX;
        if (!big) return;
        points = g.tool === 'arrow' ? [a, b] : [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y + r.height }];
      }
      const sw = useMarkup.getState().strokeWidth;
      s.addMeasurement({
        id: newId(),
        page: s.currentPage,
        kind: g.tool,
        label: `${KIND_LABEL_PREFIX[g.tool]} ${nextLabelNumber(s.measurements, g.tool)}`,
        points,
        ...(sw !== DEFAULT_STROKE_WIDTH ? { strokeWidth: sw } : {}),
        ...newMeasurementStyle(s, g.tool),
      });
    };

    const flushOverride = () => {
      overrideFrame = 0;
      setOverride(pendingOverride);
    };
    const queueOverride = (o: { id: string; points: Point[] } | null) => {
      pendingOverride = o;
      if (o === null) {
        cancelAnimationFrame(overrideFrame);
        flushOverride();
      } else if (!overrideFrame) overrideFrame = requestAnimationFrame(flushOverride);
    };

    // ---- pointer events -----------------------------------------------------
    const startPinch = () => {
      const [a, b] = [...pointers.keys()];
      const pa = pointers.get(a)!;
      const pb = pointers.get(b)!;
      gesture = {
        kind: 'pinch',
        a,
        b,
        dist: Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y)),
        mx: (pa.x + pb.x) / 2,
        my: (pa.y + pb.y) / 2,
      };
    };

    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest?.('[data-viewer-ui]')) return;
      const s = st();
      if (s.numPages === 0) return;
      // Right-click or Alt+click on a marker of the selected count group removes it.
      if (e.pointerType === 'mouse' && (e.button === 2 || (e.button === 0 && e.altKey)) && pointers.size === 0) {
        const g = activeCount(s);
        if (g) {
          rect = container.getBoundingClientRect();
          const q0 = local(e);
          const idx = nearestVertex(vp.toPage(q0.x, q0.y), g.points, VERTEX_PX / vp.zoom);
          if (idx >= 0) {
            e.preventDefault();
            removeMarker(s, g, idx);
            return;
          }
        }
      }
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
      rect = container.getBoundingClientRect();
      const q = local(e);
      cursor = q;
      pointers.set(e.pointerId, { ...q, type: e.pointerType });
      try {
        container.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !isTypingTarget(document.activeElement)) {
        document.activeElement.blur(); // so Space doesn't press a focused toolbar button
      }

      if (pointers.size === 2) {
        if (gesture.kind === 'vertex' || gesture.kind === 'move') queueOverride(null);
        if (gesture.kind === 'draw') updateLive(null);
        startPinch();
        updateBand();
        return;
      }
      if (pointers.size > 2) return;

      if (e.button === 1) {
        e.preventDefault(); // no autoscroll
        const now = performance.now();
        if (now - lastMiddle < DBL_MS) {
          lastMiddle = 0;
          vp.fit(true);
        } else lastMiddle = now;
        gesture = { kind: 'pan', id: e.pointerId, lx: q.x, ly: q.y, sx: q.x, sy: q.y, moved: true, clickOnUp: false };
        updateCursor();
        return;
      }

      // vertex handle of the selected measurement?
      if (!space && s.draft.length === 0 && s.selectedId) {
        const m = s.measurements.find((x) => x.id === s.selectedId && x.page === s.currentPage);
        if (m && !noHandles(m)) {
          const slop = (e.pointerType === 'touch' ? VERTEX_PX * 1.8 : VERTEX_PX) / vp.zoom;
          const idx = nearestVertex(vp.toPage(q.x, q.y), m.points, slop);
          if (idx >= 0) {
            gesture = { kind: 'vertex', id: e.pointerId, mid: m.id, index: idx, points: m.points.slice() };
            updateCursor();
            updateBand();
            return;
          }
        }
      }

      if (!space && s.tool === 'pan') {
        // Grab a markup annotation to move it (a plain click still selects it).
        const hit = hitMarkupAt(vp.toPage(q.x, q.y), s.measurements, s.currentPage, vp.zoom);
        if (hit) {
          if (s.selectedId !== hit.id) s.select(hit.id);
          gesture = { kind: 'move', id: e.pointerId, mid: hit.id, sx: q.x, sy: q.y, orig: hit.points, points: hit.points, moved: false };
          updateCursor();
          updateBand();
          return;
        }
      }
      if (e.altKey !== alt) alt = e.altKey;
      if (e.ctrlKey !== ctrl) ctrl = e.ctrlKey;
      if (!space && s.draft.length === 0 && (s.tool === 'rectArea' || (s.tool === 'deduct' && e.altKey))) {
        const a = resolvePoint(vp.toPage(q.x, q.y), null, s.tool);
        gesture = {
          kind: 'rect',
          id: e.pointerId,
          a,
          mk: s.tool === 'deduct' ? 'deduct' : 'area',
          sx: q.x,
          sy: q.y,
          moved: false,
          threshold: e.pointerType === 'touch' ? DRAG_PX_TOUCH : DRAG_PX_MOUSE,
        };
        if (s.selectedId) s.select(null);
        updateCursor();
        updateBand();
        return;
      }
      if (!space && isDragTool(s.tool)) {
        const p0 = vp.toPage(q.x, q.y);
        gesture = { kind: 'draw', id: e.pointerId, tool: s.tool, pts: [p0, p0], sx: q.x, sy: q.y, lx: q.x, ly: q.y };
        const el = markupRef.current;
        if (el) {
          const ms = useMarkup.getState();
          const color = newMeasurementStyle(s, s.tool).color;
          const hl = s.tool === 'highlight';
          el.setAttribute('stroke', hl ? 'none' : color);
          el.setAttribute('fill', hl ? color : s.tool === 'arrow' ? color : 'none');
          el.setAttribute('fill-opacity', hl ? '0.35' : '1');
          el.style.strokeWidth = `calc(${ms.strokeWidth}px * var(--inv-zoom, 1))`;
        }
        if (s.selectedId) s.select(null);
        updateCursor();
        updateBand();
        return;
      }
      if (space || s.tool === 'pan') {
        gesture = { kind: 'pan', id: e.pointerId, lx: q.x, ly: q.y, sx: q.x, sy: q.y, moved: false, clickOnUp: !space };
      } else {
        gesture = {
          kind: 'pending',
          id: e.pointerId,
          sx: q.x,
          sy: q.y,
          threshold: e.pointerType === 'touch' ? DRAG_PX_TOUCH : DRAG_PX_MOUSE,
        };
      }
      updateCursor();
      updateBand();
    };

    const onPointerMove = (e: PointerEvent) => {
      const q = local(e);
      const ptr = pointers.get(e.pointerId);
      if (ptr) {
        ptr.x = q.x;
        ptr.y = q.y;
      }
      if (e.shiftKey !== shift) shift = e.shiftKey;
      if (e.ctrlKey !== ctrl) ctrl = e.ctrlKey;
      if (e.altKey !== alt) alt = e.altKey;
      const g = gesture;
      switch (g.kind) {
        case 'pinch': {
          if (e.pointerId !== g.a && e.pointerId !== g.b) return;
          const pa = pointers.get(g.a);
          const pb = pointers.get(g.b);
          if (!pa || !pb) return;
          const dist = Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y));
          const mx = (pa.x + pb.x) / 2;
          const my = (pa.y + pb.y) / 2;
          vp.panBy(mx - g.mx, my - g.my);
          vp.zoomAt(dist / g.dist, mx, my);
          g.dist = dist;
          g.mx = mx;
          g.my = my;
          return;
        }
        case 'pan':
          if (e.pointerId !== g.id) return;
          if (!g.moved && Math.hypot(q.x - g.sx, q.y - g.sy) > DRAG_PX_MOUSE) {
            g.moved = true;
            updateCursor();
          }
          vp.panBy(q.x - g.lx, q.y - g.ly);
          g.lx = q.x;
          g.ly = q.y;
          return;
        case 'pending':
          if (e.pointerId !== g.id) return;
          if (Math.hypot(q.x - g.sx, q.y - g.sy) > g.threshold) {
            gesture = { kind: 'pan', id: g.id, lx: q.x, ly: q.y, sx: g.sx, sy: g.sy, moved: true, clickOnUp: false };
            vp.panBy(q.x - g.sx, q.y - g.sy);
            updateCursor();
            updateBand();
          }
          return;
        case 'rect': {
          if (e.pointerId !== g.id) return;
          if (!g.moved && Math.hypot(q.x - g.sx, q.y - g.sy) > g.threshold) g.moved = true;
          cursor = q;
          updateBand();
          return;
        }
        case 'vertex': {
          if (e.pointerId !== g.id) return;
          const pts = g.points.slice();
          const vm = st().measurements.find((x) => x.id === g.mid);
          if (vm && !isMarkupKind(vm.kind)) {
            const n = g.points.length;
            const nb = kindOf(vm) === 'count' || (kindOf(vm) === 'length' && g.index === 0) ? null : g.points[(g.index - 1 + n) % n];
            pts[g.index] = resolvePoint(vp.toPage(q.x, q.y), shift ? nb : null, kindOf(vm) as ToolId, vm.id);
            updateMarker(true);
          } else pts[g.index] = vp.toPage(q.x, q.y);
          g.points = pts;
          queueOverride({ id: g.mid, points: pts });
          return;
        }
        case 'draw': {
          if (e.pointerId !== g.id) return;
          const p = vp.toPage(q.x, q.y);
          if (g.tool === 'pen') {
            if (Math.hypot(q.x - g.lx, q.y - g.ly) < 1) return;
            g.pts.push(p);
          } else {
            const a = g.pts[0];
            g.pts = [a, shift && g.tool === 'arrow' ? snapAngle(a, p, 45) : p];
          }
          g.lx = q.x;
          g.ly = q.y;
          updateLive(g);
          return;
        }
        case 'move': {
          if (e.pointerId !== g.id) return;
          if (!g.moved && Math.hypot(q.x - g.sx, q.y - g.sy) <= (e.pointerType === 'touch' ? DRAG_PX_TOUCH : DRAG_PX_MOUSE)) return;
          g.moved = true;
          g.points = translatePoints(g.orig, (q.x - g.sx) / vp.zoom, (q.y - g.sy) / vp.zoom);
          queueOverride({ id: g.mid, points: g.points });
          return;
        }
        case 'none':
          if (e.pointerType !== 'touch') {
            cursor = q;
            updateHover();
            updateBand();
            updateCursor();
          }
      }
    };

    const endPointer = (e: PointerEvent, cancelled: boolean) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      const q = local(e);
      const g = gesture;
      if (g.kind === 'pinch') {
        // continue panning with the remaining finger (no click)
        const [rest] = [...pointers.entries()];
        gesture = rest
          ? { kind: 'pan', id: rest[0], lx: rest[1].x, ly: rest[1].y, sx: rest[1].x, sy: rest[1].y, moved: true, clickOnUp: false }
          : { kind: 'none' };
      } else if (g.kind === 'rect' && g.id === e.pointerId) {
        gesture = { kind: 'none' };
        if (!cancelled) {
          if (g.moved) finishRect(g.a, resolvePoint(vp.toPage(q.x, q.y), null, st().tool), g.mk);
          else {
            // plain click: first corner placed; the next click sets the opposite corner
            rectMode = true;
            st().setDraft([g.a]);
          }
        }
      } else if (g.kind === 'draw' && g.id === e.pointerId) {
        gesture = { kind: 'none' };
        if (!cancelled) finishDraw(g);
        else updateLive(null);
      } else if (g.kind === 'move' && g.id === e.pointerId) {
        gesture = { kind: 'none' };
        if (!cancelled && g.moved) st().updateMeasurement(g.mid, { points: g.points });
        else if (!cancelled) {
          // Plain click on a markup: double click edits note / text.
          const now = performance.now();
          const m = st().measurements.find((x) => x.id === g.mid);
          if (lastMarkupClick && lastMarkupClick.id === g.mid && now - lastMarkupClick.t < DBL_MS && (m?.kind === 'note' || m?.kind === 'text')) {
            lastMarkupClick = null;
            useMarkup.getState().startEditing(g.mid);
          } else lastMarkupClick = { t: now, id: g.mid };
        }
        if (g.moved) queueOverride(null);
      } else if ((g.kind === 'pan' || g.kind === 'pending' || g.kind === 'vertex') && g.id === e.pointerId) {
        gesture = { kind: 'none' };
        if (!cancelled) {
          if (g.kind === 'pending') click(q.x, q.y);
          else if (g.kind === 'pan' && g.clickOnUp && !g.moved) click(q.x, q.y);
          else if (g.kind === 'vertex') {
            const m = st().measurements.find((x) => x.id === g.mid);
            if (m && g.points.length >= minPoints(kindOf(m))) st().updateMeasurement(g.mid, { points: g.points });
          }
        }
        if (g.kind === 'vertex') {
          queueOverride(null);
          snapHit = null;
          updateMarker(false);
        }
      }
      if (e.pointerType !== 'touch' || !cancelled) cursor = q;
      updateCursor();
      updateBand();
    };
    const onPointerUp = (e: PointerEvent) => endPointer(e, false);
    const onPointerCancel = (e: PointerEvent) => endPointer(e, true);
    const onPointerLeave = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && gesture.kind === 'none') {
        cursor = null;
        updateBand();
      }
    };

    // Wheel MUST be non-passive: preventDefault() is the only way to stop the
    // browser from scrolling the page / applying its own pinch-zoom (ctrl+wheel)
    // while we zoom the drawing. All other listeners stay passive.
    const onWheel = (e: WheelEvent) => {
      if (st().numPages === 0) return;
      e.preventDefault();
      const q = local(e);
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      } else if (e.deltaMode === 2) {
        dx *= vp.ch;
        dy *= vp.ch;
      }
      if (e.ctrlKey || e.metaKey) {
        // trackpad pinch (reported as ctrl+wheel) → direct, proportional
        vp.zoomAt(Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01), q.x, q.y);
      } else if (e.shiftKey) {
        vp.panBy(-(dx || dy), 0);
      } else {
        if (dy) vp.zoomSmooth(Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0025), q.x, q.y);
        if (dx) vp.panBy(-dx, 0);
      }
    };

    // ---- keyboard -----------------------------------------------------------
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const s = st();
      if (s.numPages === 0) return;
      if (e.key === 'Shift') {
        shift = true;
        updateBand();
        return;
      }
      if (e.key === 'Control' || e.key === 'Alt') {
        if (e.key === 'Control') ctrl = true;
        else {
          alt = true;
          if (s.tool === 'deduct') e.preventDefault(); // keep focus off the browser menu bar
        }
        updateBand();
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (!space) {
          space = true;
          updateCursor();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      switch (e.code) {
        case 'Digit0':
        case 'Numpad0':
        case 'KeyF':
          vp.fit(true);
          break;
        case 'Equal':
        case 'NumpadAdd':
          vp.zoomBy(ZOOM_STEP);
          break;
        case 'Minus':
        case 'NumpadSubtract':
          vp.zoomBy(1 / ZOOM_STEP);
          break;
        case 'Escape':
          if (gesture.kind === 'draw') {
            gesture = { kind: 'none' };
            updateLive(null);
          } else if (gesture.kind === 'rect') {
            gesture = { kind: 'none' };
            updateBand();
          } else if (s.draft.length) s.setDraft([]);
          else if (s.selectedId) s.select(null);
          else handled = false;
          break;
        case 'Backspace':
          if (s.draft.length) s.setDraft(s.draft.slice(0, -1));
          else if (s.tool === 'count' && activeCount(s)) {
            const g = activeCount(s)!;
            removeMarker(s, g, g.points.length - 1);
          }
          else if (s.selectedId) s.removeMeasurement(s.selectedId);
          else handled = false;
          break;
        case 'Delete':
          if (s.selectedId && !s.draft.length) s.removeMeasurement(s.selectedId);
          else handled = false;
          break;
        case 'Enter':
        case 'NumpadEnter':
          if (toolKind(s.tool) && s.draft.length >= minPoints(toolKind(s.tool)!)) finishDraft();
          else if (s.tool === 'count' && activeCount(s)) s.select(null); // finish the count group
          else if (s.selectedId && !s.draft.length) {
            const m = s.measurements.find((x) => x.id === s.selectedId);
            if (m && (m.kind === 'note' || m.kind === 'text')) useMarkup.getState().startEditing(m.id);
            else handled = false;
          } else handled = false;
          break;
        default:
          if (e.key === '+') vp.zoomBy(ZOOM_STEP);
          else handled = false;
      }
      if (handled) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shift = false;
        updateBand();
      }
      if (e.key === 'Control' || e.key === 'Alt') {
        if (e.key === 'Control') ctrl = false;
        else alt = false;
        updateBand();
      }
      if (e.code === 'Space' && space) {
        space = false;
        e.preventDefault();
        updateCursor();
      }
    };
    const onBlur = () => {
      space = false;
      shift = false;
      ctrl = false;
      alt = false;
      updateCursor();
    };
    const onContextMenu = (e: MouseEvent) => {
      const s = st();
      if (s.draft.length || s.tool === 'count' || activeCount(s)) e.preventDefault();
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove, { passive: true });
    container.addEventListener('pointerup', onPointerUp, { passive: true });
    container.addEventListener('pointercancel', onPointerCancel, { passive: true });
    container.addEventListener('pointerleave', onPointerLeave, { passive: true });
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    const ro = new ResizeObserver(() => {
      rect = container.getBoundingClientRect();
      vp.setContainerSize(rect.width, rect.height);
    });
    ro.observe(container);
    vp.setContainerSize(rect.width, rect.height);

    if (import.meta.env.DEV || /[?&]bench\b/.test(window.location.search)) {
      // Test / benchmark hook (dev builds, or any build opened with ?bench).
      (window as unknown as { __viewer?: unknown }).__viewer = {
        vp,
        layers,
        isSharp: () => layers.isSharp(vp.zoom, vp.visibleRect()),
        setPage: (n: number) => useViewer.getState().setPage(n),
        client: getPdfClient(),
        store: useViewer,
      };
    }

    return () => {
      ro.disconnect();
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerCancel);
      container.removeEventListener('pointerleave', onPointerLeave);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      clearTimeout(settleTimer);
      clearTimeout(targetTimer);
      cancelAnimationFrame(overrideFrame);
      unsubscribe();
      registerViewer(null);
      layers.destroy();
      layersRef.current = null;
      vp.setWorld(null);
      hooks.current = { updateBand: () => {}, updateCursor: () => {} };
    };
  }, [vp]);

  // ---------------------------------------------------------------------------
  // Page / document changes: fit + (re)load rasters.
  // ---------------------------------------------------------------------------
  const pw = size?.width ?? 0;
  const ph = size?.height ?? 0;
  const pageSizesRef = useRef(pageSizes);
  pageSizesRef.current = pageSizes;
  const layoutKey = useLayoutEpoch(docs, fileName, numPages);
  useEffect(() => {
    const layers = layersRef.current;
    setOverride(null);
    if (!layers) return;
    if (!(pw > 0 && ph > 0)) {
      layers.clear();
      vp.setPageSize(0, 0);
      return;
    }
    vp.setPageSize(pw, ph);
    vp.fit(false);
    const focus = takePendingFocus(currentPage); // text-search result on another page
    if (focus) vp.zoomToRect(focus, false);
    layers.setPage(layoutKey, currentPage, { width: pw, height: ph }, pageSizesRef.current);
  }, [vp, layoutKey, currentPage, pw, ph]);

  // A new pageSizes array alone (e.g. a file appended to the workspace) only refreshes the prefetch list.
  useEffect(() => {
    layersRef.current?.setSizes(pageSizes);
  }, [pageSizes]);

  // Rubber band / cursor depend on tool + draft + calibration.
  useEffect(() => {
    hooks.current.updateBand();
    hooks.current.updateCursor();
  }, [tool, draft, calibration, selectedId, measurements, editingId, snapOn]);

  const showPrompt = tool === 'calibrate' && draft.length === 2;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 select-none overflow-hidden bg-neutral-300 outline-none dark:bg-neutral-700"
      style={{ touchAction: 'none', contain: 'strict' }}
      data-testid="viewer"
    >
      <div
        ref={worldRef}
        className="absolute left-0 top-0 bg-white"
        style={{
          width: pw,
          height: ph,
          transformOrigin: '0 0',
          pointerEvents: 'none',
          visibility: size ? 'visible' : 'hidden',
          boxShadow: '0 0 0 calc(1px * var(--inv-zoom, 1)) rgba(0,0,0,0.25)',
        }}
        data-testid="viewer-world"
      >
        <canvas
          ref={baseRef}
          className="absolute left-0 top-0"
          style={{ transformOrigin: '0 0', zIndex: 0 }}
          data-testid="base-layer"
        />
        <div ref={tilesRef} className="absolute left-0 top-0" style={{ zIndex: 10 }} data-testid="sharp-layer" />
        {size && (
          <MeasureOverlay
            width={pw}
            height={ph}
            measurements={pageMeasurements}
            selectedId={selectedId}
            calibration={calibration}
            draft={draft}
            tool={tool}
            override={override}
            band={band}
          />
        )}
        {size && <TextHighlights page={currentPage} />}
        {size && <NoteBubbles notes={pageNotes} selectedId={selectedId} editingId={editingId} />}
        {editing && <MarkupEditor key={editing.id} m={editing} />}
        {showPrompt && <CalibrationPrompt key={`${draft[0].x},${draft[0].y},${draft[1].x},${draft[1].y}`} p1={draft[0]} p2={draft[1]} />}
      </div>
      <div
        ref={readoutRef}
        dir="rtl"
        className="pointer-events-none absolute left-0 top-0 z-30 hidden whitespace-nowrap rounded bg-white/95 px-2 py-0.5 text-xs font-medium text-neutral-800 shadow ring-1 ring-black/10"
        data-testid="viewer-readout"
      />
      <SnapMarker ref={snapMarkerRef} />
    </div>
  );
}

/**
 * Geometry-snap marker (screen px, positioned imperatively): square = endpoint,
 * triangle = midpoint, X = intersection — shape picked by CSS from data-kind.
 */
function SnapMarker({ ref }: { ref: React.Ref<SVGSVGElement> }) {
  return (
    <svg
      ref={ref}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      className="snap-marker pointer-events-none absolute left-0 top-0 z-30"
      style={{ display: 'none', overflow: 'visible' }}
      data-testid="snap-marker"
      aria-hidden="true"
    >
      <style>{`.snap-marker>g{display:none}.snap-marker[data-kind=end]>.k-end,.snap-marker[data-kind=mid]>.k-mid,.snap-marker[data-kind=x]>.k-x{display:inline}`}</style>
      <g className="k-end" fill="none" strokeWidth={2}>
        <rect x={2} y={2} width={12} height={12} stroke="#fff" strokeWidth={4} />
        <rect x={2} y={2} width={12} height={12} stroke="#16a34a" />
      </g>
      <g className="k-mid" fill="none" strokeLinejoin="round">
        <path d="M8 1.5 15 14H1Z" stroke="#fff" strokeWidth={4} />
        <path d="M8 1.5 15 14H1Z" stroke="#0891b2" strokeWidth={2} />
      </g>
      <g className="k-x" fill="none" strokeLinecap="round">
        <path d="M2 2 14 14M14 2 2 14" stroke="#fff" strokeWidth={4.5} />
        <path d="M2 2 14 14M14 2 2 14" stroke="#ea580c" strokeWidth={2.2} />
      </g>
    </svg>
  );
}

/** Floating "real length" input shown after the 2nd calibration point. */
function CalibrationPrompt({ p1, p2 }: { p1: Point; p2: Point }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const cancel = () => useViewer.getState().setDraft([]);
  const ok = () => {
    const m = parseLengthInput(value);
    if (m === null || !(m > 0) || distance(p1, p2) === 0) {
      setError(true);
      inputRef.current?.focus();
      return;
    }
    const s = useViewer.getState();
    s.setCalibration(s.currentPage, { pixelsPerMeter: computePixelsPerMeter(p1, p2, m), p1, p2, meters: m });
    s.setDraft([]);
    s.setTool('area');
  };

  // Below the lower end of the line, in page units; scaled by 1/zoom to stay screen-sized.
  const mid = { x: (p1.x + p2.x) / 2, y: Math.max(p1.y, p2.y) };
  return (
    <div
      data-viewer-ui
      className="absolute"
      style={{
        left: mid.x,
        top: mid.y,
        transformOrigin: '0 0',
        transform: `scale(var(--inv-zoom, 1)) translate(-50%, 14px)`,
        pointerEvents: 'auto',
        zIndex: 40,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <form
        dir="rtl"
        className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-white p-1.5 text-sm shadow-lg ring-1 ring-black/15"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <label className="font-medium text-neutral-700" htmlFor="calib-len">
          אורך אמיתי (מ׳)
        </label>
        <input
          id="calib-len"
          ref={inputRef}
          value={value}
          inputMode="decimal"
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          className={`w-20 rounded border px-1.5 py-0.5 text-left outline-none focus:ring-2 ${
            error ? 'border-red-500 ring-red-300' : 'border-neutral-300 ring-blue-300'
          }`}
          dir="ltr"
          placeholder="5.00"
          data-testid="calibration-input"
        />
        <button type="submit" className="rounded bg-blue-600 px-2 py-0.5 font-medium text-white hover:bg-blue-700">
          אישור
        </button>
        <button type="button" onClick={cancel} className="rounded px-2 py-0.5 text-neutral-600 hover:bg-neutral-100">
          ביטול
        </button>
      </form>
    </div>
  );
}

/**
 * Identity of the page layout for raster caches: changes only when existing
 * global page numbers may now show different content (a doc removed /
 * reordered, or another document opened) — NOT when a file is appended to the
 * workspace (all old global pages keep their doc + local page).
 */
function useLayoutEpoch(
  docs: { id: string; pageOffset: number; numPages: number }[] | undefined,
  fileName: string | null,
  numPages: number,
): number {
  const ref = useRef<{ epoch: number; layout: { id: string; pageOffset: number; numPages: number }[]; fileName: string | null } | null>(null);
  const layout = (docs ?? []).map((d) => ({ id: d.id, pageOffset: d.pageOffset, numPages: d.numPages }));
  const prev = ref.current;
  if (!prev) {
    ref.current = { epoch: 0, layout, fileName };
    return 0;
  }
  const extends_ =
    layout.length > 0 && prev.layout.length > 0
      ? prev.fileName === fileName &&
        prev.layout.every((o) => layout.some((n) => n.id === o.id && n.pageOffset === o.pageOffset && n.numPages === o.numPages))
      : prev.fileName === fileName && prev.layout.length === layout.length && numPages > 0;
  if (!extends_) ref.current = { epoch: prev.epoch + 1, layout, fileName };
  else ref.current = { ...prev, layout, fileName };
  return ref.current.epoch;
}
