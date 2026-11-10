/**
 * Cheap `getTransform()` for the 2D context pdf.js renders into.
 *
 * pdf.js 4.x calls `ctx.getTransform()` for EVERY path (constructPath, and again around each
 * hairline stroke — see the rescaleAndStroke patch in pdfjsPatchPlugin.ts). In Blink / WebKit each
 * call allocates a native DOMMatrix that lives in the engine's C++ GC heap; the JS GC does not see
 * that memory pressure, so on a drawing with ~900k paths one render left hundreds of MB of garbage
 * behind (measured as Oilpan "embedder heap" in the render worker) — enough for iOS to kill the
 * PWA while zooming a heavy drawing.
 *
 * `trackTransform(ctx)` caches the transform the native context reported, as plain numbers, and
 * answers `getTransform()` from that cache with a small JS object (a, b, c, d, e, f + `invertSelf`,
 * which is all pdf.js uses; it is also a valid DOMMatrix2DInit). The values are always EXACTLY what
 * the native context holds — never computed here (Chromium keeps the matrix in float32, WebKit in
 * double, so recomputing it in JS would differ in the last bits and change pdf.js' hairline
 * decisions):
 *  - any transform change (transform/translate/scale/rotate/…) invalidates the cache, and the next
 *    getTransform() reads the native matrix once;
 *  - save()/restore() push/pop the cache with the native state stack;
 *  - setTransform(values) caches the values when they are float32-representable (then both engines
 *    store them exactly) — e.g. pdf.js restoring a matrix it read before.
 * So between transform changes (pdf.js draws hundreds of thousands of paths under one transform)
 * no native matrix is allocated at all.
 */

type M6 = [number, number, number, number, number, number];

/** What `getTransform()` returns on a tracked context. */
export class TrackedMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  constructor(m: Readonly<M6>) {
    this.a = m[0];
    this.b = m[1];
    this.c = m[2];
    this.d = m[3];
    this.e = m[4];
    this.f = m[5];
  }
  get is2D(): boolean {
    return true;
  }
  invertSelf(): this {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) {
      this.a = this.b = this.c = this.d = this.e = this.f = NaN; // same as DOMMatrix.invertSelf
      return this;
    }
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }
}

/** The subset of the 2D context API this module wraps. */
export interface TransformContext {
  save(): void;
  restore(): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  rotate(angle: number): void;
  setTransform(...args: unknown[]): void;
  resetTransform(): void;
  getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number };
  reset?: () => void;
}

const TRACKED = Symbol('pvTrackedTransform');

const exactFloat32 = (v: readonly number[]) => v.every((x) => Number.isFinite(x) && Math.fround(x) === x);

/**
 * Install the transform cache on `ctx` (idempotent). Call right after getContext(), before
 * anything else touches the context (state stack must be empty).
 */
export function trackTransform<C extends object>(ctx: C): C {
  const c = ctx as unknown as TransformContext & { [TRACKED]?: true };
  if (c[TRACKED]) return ctx;
  // The native methods (from the prototype chain, before we shadow them on the instance).
  const native = {
    save: c.save,
    restore: c.restore,
    transform: c.transform,
    translate: c.translate,
    scale: c.scale,
    rotate: c.rotate,
    setTransform: c.setTransform,
    resetTransform: c.resetTransform,
    getTransform: c.getTransform,
    reset: c.reset,
  };
  /** The native transform, or null = unknown (read it on the next getTransform). */
  let m: M6 | null = null;
  const stack: (M6 | null)[] = [];

  const wrappers: Partial<TransformContext> = {
    save() {
      native.save.call(c);
      stack.push(m);
    },
    restore() {
      native.restore.call(c);
      // An unbalanced restore() is a no-op natively; the transform is unchanged then.
      if (stack.length) m = stack.pop()!;
    },
    transform(a: number, b: number, cc: number, d: number, e: number, f: number) {
      native.transform.call(c, a, b, cc, d, e, f);
      m = null;
    },
    translate(x: number, y: number) {
      native.translate.call(c, x, y);
      m = null;
    },
    scale(x: number, y: number) {
      native.scale.call(c, x, y);
      m = null;
    },
    rotate(angle: number) {
      native.rotate.call(c, angle);
      m = null;
    },
    setTransform(...args: unknown[]) {
      if (args.length === 1 && args[0] instanceof TrackedMatrix) {
        const t = args[0];
        args = [t.a, t.b, t.c, t.d, t.e, t.f];
      }
      native.setTransform.apply(c, args);
      const v = args.length === 6 ? (args as number[]) : null;
      m = v && v.every((x) => typeof x === 'number') && exactFloat32(v) ? (v.slice() as M6) : null;
    },
    resetTransform() {
      native.resetTransform.call(c);
      m = [1, 0, 0, 1, 0, 0];
    },
    getTransform() {
      if (!m) {
        const t = native.getTransform.call(c);
        m = [t.a, t.b, t.c, t.d, t.e, t.f];
      }
      return new TrackedMatrix(m);
    },
  };
  if (native.reset) {
    wrappers.reset = () => {
      native.reset!.call(c);
      stack.length = 0;
      m = [1, 0, 0, 1, 0, 0];
    };
  }
  Object.assign(c, wrappers);
  c[TRACKED] = true;
  return ctx;
}
