import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TrackedMatrix, trackTransform } from './ctxTransform';
import { patchPdfjsDisplay } from './pdfjsPatchPlugin';

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const fin = (...v: number[]) => v.every(Number.isFinite);

/** Reference 2D context (spec semantics; matrix kept in float32 like Chromium); counts native getTransform calls. */
class FakeCtx {
  private _m: M = [1, 0, 0, 1, 0, 0];
  get m(): M {
    return this._m;
  }
  set m(v: M) {
    this._m = v.map(Math.fround) as M;
  }
  stack: M[] = [];
  getTransformCalls = 0;
  save() {
    this.stack.push([...this.m] as M);
  }
  restore() {
    const p = this.stack.pop();
    if (p) this.m = p;
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    if (fin(a, b, c, d, e, f)) this.m = mul(this.m, [a, b, c, d, e, f]);
  }
  translate(x: number, y: number) {
    if (fin(x, y)) this.m = mul(this.m, [1, 0, 0, 1, x, y]);
  }
  scale(x: number, y: number) {
    if (fin(x, y)) this.m = mul(this.m, [x, 0, 0, y, 0, 0]);
  }
  rotate(r: number) {
    if (fin(r)) this.m = mul(this.m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
  }
  setTransform(...a: unknown[]) {
    if (a.length === 0) this.m = [1, 0, 0, 1, 0, 0];
    else if (a.length === 1) {
      const t = a[0] as { a: number; b: number; c: number; d: number; e: number; f: number };
      this.m = [t.a, t.b, t.c, t.d, t.e, t.f];
    } else if (fin(...(a as number[]))) this.m = (a as number[]).slice(0, 6) as M;
  }
  resetTransform() {
    this.m = [1, 0, 0, 1, 0, 0];
  }
  getTransform() {
    this.getTransformCalls++;
    const [a, b, c, d, e, f] = this.m;
    return { a, b, c, d, e, f };
  }
}

const asArr = (t: { a: number; b: number; c: number; d: number; e: number; f: number }) => [t.a, t.b, t.c, t.d, t.e, t.f];

describe('trackTransform', () => {
  it('always returns exactly the native matrix through random sequences', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 4 - 2;
    for (let run = 0; run < 50; run++) {
      const ctx = new FakeCtx();
      ctx.translate(3, 4); // state before tracking starts is picked up
      trackTransform(ctx);
      for (let i = 0; i < 200; i++) {
        const op = Math.floor(Math.abs(rnd()) * 4.5);
        if (op === 0) ctx.save();
        else if (op === 1) ctx.restore();
        else if (op === 2) ctx.transform(rnd(), rnd(), rnd(), rnd(), rnd(), rnd());
        else if (op === 3) ctx.translate(rnd(), rnd());
        else if (op === 4) ctx.scale(rnd() || 1, rnd() || 1);
        if (i === 100) ctx.setTransform(1, 2, 3, 4, 5, 6);
        if (i === 120) ctx.setTransform(0.1, 0, 0, 0.3, 0.7, 1 / 3); // not float32-exact: re-read
        if (i === 140) ctx.rotate(0.3);
        if (i === 150) ctx.transform(NaN, 1, 1, 1, 1, 1); // ignored natively
        if (i % 3 === 0) expect(asArr(ctx.getTransform())).toEqual(ctx.m);
      }
    }
  });

  it('reads the native matrix only after it changed (save/restore and exact setTransform need no read)', () => {
    const ctx = new FakeCtx();
    trackTransform(ctx);
    ctx.scale(0.95, -0.95);
    ctx.getTransform();
    const base = ctx.getTransformCalls;
    for (let i = 0; i < 100; i++) ctx.getTransform(); // many paths under one transform
    expect(ctx.getTransformCalls).toBe(base);
    // patched rescaleAndStroke: read, scale, stroke, put back
    const saved = ctx.getTransform();
    expect(saved).toBeInstanceOf(TrackedMatrix);
    ctx.scale(3, 3);
    ctx.setTransform(saved);
    ctx.save();
    ctx.translate(1, 2);
    ctx.restore();
    expect(asArr(ctx.getTransform())).toEqual(ctx.m);
    expect(ctx.getTransformCalls).toBe(base);
    ctx.translate(5, 5);
    expect(asArr(ctx.getTransform())).toEqual(ctx.m);
    expect(ctx.getTransformCalls).toBe(base + 1);
  });

  it('invertSelf, setTransform(object), resetTransform and unbalanced restore', () => {
    const ctx = new FakeCtx();
    trackTransform(ctx);
    ctx.setTransform({ a: 4, b: 0, c: 0, d: 5, e: 9, f: 8 });
    expect(asArr(ctx.getTransform())).toEqual([4, 0, 0, 5, 9, 8]);
    const inv = (ctx.getTransform() as TrackedMatrix).invertSelf();
    const id = mul(ctx.m, asArr(inv) as M);
    [1, 0, 0, 1, 0, 0].forEach((v, k) => expect(id[k]).toBeCloseTo(v, 12));
    ctx.resetTransform();
    expect(asArr(ctx.getTransform())).toEqual([1, 0, 0, 1, 0, 0]);
    ctx.restore(); // unbalanced: no-op
    expect(asArr(ctx.getTransform())).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe('pdf.js display patch', () => {
  it('applies to the installed pdfjs-dist (fails when pdf.js changes the patched code)', () => {
    const require = createRequire(import.meta.url);
    const file = require.resolve('pdfjs-dist/build/pdf.mjs');
    const out = patchPdfjsDisplay(readFileSync(file, 'utf8'));
    expect(out).toContain('pdf-viewer patch');
    expect(() => patchPdfjsDisplay(out)).toThrow(); // exact-match, single occurrence
  });
});
