import { describe, expect, it } from 'vitest';
import { SNAP_ENDPOINT, SNAP_INTERSECTION, SNAP_MIDPOINT, snapPointsFromOperatorList, type SnapOps } from './vectorSnap';
import { SnapIndex, projectOnRay } from './snapIndex';

// pdf.js 4.10 OPS codes
const OPS: SnapOps = {
  save: 10, restore: 11, transform: 12, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, closePath: 18,
  rectangle: 19, stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26,
  closeEOFillStroke: 27, endPath: 28, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77,
  beginAnnotation: 80, endAnnotation: 81, constructPath: 91,
};
// Typical viewport at scale 1 for a 200×100 page: flips y.
const VT = [1, 0, 0, -1, 0, 100];

function list(...ops: [number, unknown][]) {
  return { fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1]) };
}
const path = (ops: number[], coords: number[]): [number, unknown] => [OPS.constructPath, [ops, coords, null]];
const pts = (r: ReturnType<typeof snapPointsFromOperatorList>, kind?: number) => {
  const out: [number, number][] = [];
  for (let i = 0; i < r.count; i++) if (kind === undefined || r.kind[i] === kind) out.push([r.xy[i * 2], r.xy[i * 2 + 1]]);
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
};

describe('vector snap extraction', () => {
  it('applies the viewport transform to a stroked line', () => {
    const r = snapPointsFromOperatorList(list(path([OPS.moveTo, OPS.lineTo], [10, 10, 50, 10]), [OPS.stroke, null]), OPS, VT);
    expect(r.segments).toBe(1);
    expect(pts(r, SNAP_ENDPOINT)).toEqual([[10, 90], [50, 90]]);
    expect(pts(r, SNAP_MIDPOINT)).toEqual([[30, 90]]);
  });

  it('rectangles give 4 corners; clip-only paths are ignored', () => {
    const r = snapPointsFromOperatorList(
      list(path([OPS.rectangle], [0, 0, 200, 100]), [OPS.endPath, null], path([OPS.rectangle], [10, 20, 30, 40]), [OPS.fill, null]),
      OPS,
      VT,
    );
    expect(pts(r, SNAP_ENDPOINT)).toEqual([[10, 40], [10, 80], [40, 40], [40, 80]]);
    expect(r.segments).toBe(4);
  });

  it('tracks save / transform / restore and form XObject matrices', () => {
    const r = snapPointsFromOperatorList(
      list(
        [OPS.save, null],
        [OPS.transform, [2, 0, 0, 2, 10, 0]],
        path([OPS.moveTo, OPS.lineTo], [0, 0, 10, 0]),
        [OPS.stroke, null],
        [OPS.restore, null],
        [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 0, 50], null]],
        path([OPS.moveTo, OPS.lineTo], [0, 0, 0, 10]),
        [OPS.stroke, null],
        [OPS.paintFormXObjectEnd, null],
        path([OPS.moveTo, OPS.lineTo], [100, 0, 110, 0]),
        [OPS.stroke, null],
      ),
      OPS,
      VT,
    );
    expect(pts(r, SNAP_ENDPOINT)).toEqual([[0, 40], [0, 50], [10, 100], [30, 100], [100, 100], [110, 100]]);
  });

  it('finds proper intersections but not shared endpoints', () => {
    const r = snapPointsFromOperatorList(
      list(path([OPS.moveTo, OPS.lineTo, OPS.moveTo, OPS.lineTo, OPS.lineTo], [0, 50, 100, 50, 50, 0, 50, 100, 100, 100]), [OPS.stroke, null]),
      OPS,
      [1, 0, 0, 1, 0, 0],
    );
    expect(pts(r, SNAP_INTERSECTION)).toEqual([[50, 50]]);
  });

  it('curve ends are endpoints; closePath closes', () => {
    const r = snapPointsFromOperatorList(
      list(path([OPS.moveTo, OPS.curveTo, OPS.lineTo, OPS.closePath], [0, 0, 5, 5, 10, 5, 20, 0, 20, 20]), [OPS.fillStroke, null]),
      OPS,
      [1, 0, 0, 1, 0, 0],
    );
    expect(pts(r, SNAP_ENDPOINT)).toEqual([[0, 0], [20, 0], [20, 20]]);
    expect(r.segments).toBe(2); // 20,0→20,20 and the closing 20,20→0,0
  });

  it('respects the point cap', () => {
    const coords: number[] = [];
    const ops: number[] = [];
    for (let i = 0; i < 1000; i++) {
      ops.push(OPS.moveTo, OPS.lineTo);
      coords.push(i * 3, 0, i * 3, 5);
    }
    const r = snapPointsFromOperatorList(list(path(ops, coords), [OPS.stroke, null]), OPS, [1, 0, 0, 1, 0, 0], { maxPoints: 500 });
    expect(r.count).toBe(500);
    expect(r.truncated).toBe(true);
  });
});

describe('SnapIndex', () => {
  const xy = new Float32Array([0, 0, 10, 0, 5, 0, 100, 100]);
  const kind = new Uint8Array([SNAP_ENDPOINT, SNAP_ENDPOINT, SNAP_MIDPOINT, SNAP_INTERSECTION]);
  const idx = new SnapIndex(xy, kind);

  it('finds the nearest point within the radius', () => {
    expect(idx.nearest({ x: 99, y: 98 }, 5)).toMatchObject({ x: 100, y: 100, kind: SNAP_INTERSECTION });
    expect(idx.nearest({ x: 50, y: 50 }, 5)).toBeNull();
  });

  it('prefers an endpoint over a slightly closer midpoint', () => {
    // at 7.3: endpoint 2.7 vs midpoint 2.3 × 1.35 = 3.1 → endpoint; at 6.5 the midpoint is clearly closer
    expect(idx.nearest({ x: 7.3, y: 0 }, 5)).toMatchObject({ x: 10, kind: SNAP_ENDPOINT });
    expect(idx.nearest({ x: 6.5, y: 0 }, 5)).toMatchObject({ x: 5, kind: SNAP_MIDPOINT });
  });

  it('matches brute force on random data', () => {
    const n = 20000;
    const a = new Float32Array(n * 2);
    const k = new Uint8Array(n);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      a[i * 2] = rnd() * 1000;
      a[i * 2 + 1] = rnd() * 700;
      k[i] = SNAP_ENDPOINT;
    }
    const g = new SnapIndex(a, k);
    for (let t = 0; t < 200; t++) {
      const p = { x: rnd() * 1000, y: rnd() * 700 };
      let best = Infinity;
      for (let i = 0; i < n; i++) best = Math.min(best, Math.hypot(a[i * 2] - p.x, a[i * 2 + 1] - p.y));
      const h = g.nearest(p, 6);
      if (best <= 6) expect(h!.dist).toBeCloseTo(best, 4);
      else expect(h).toBeNull();
    }
  });

  it('projects onto an ortho ray', () => {
    expect(projectOnRay({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 7, y: 3 })).toEqual({ x: 7, y: 0 });
  });
});
