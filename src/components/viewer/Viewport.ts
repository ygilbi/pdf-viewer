import type { Point, Rect } from '../../core/types';

/**
 * Owns the view transform (zoom + pan) completely outside React.
 *
 * screen = page * zoom + pan   (screen = CSS px relative to the container's
 * top-left, page = PDF page units). The transform is written to the "world"
 * element as one `translate3d(...) scale(...)`, so pan/zoom is pure GPU
 * compositing: no React render, no layout, no PDF re-render.
 *
 * All mutators only update the model and schedule ONE write per animation
 * frame, so any number of pointer/wheel events per frame coalesce.
 */

const MAX_ZOOM = 64;
const FIT_PADDING = 16; // CSS px around the page when fitted

type Anim =
  | { kind: 'smooth'; target: number; ax: number; ay: number }
  | {
      kind: 'tween';
      t0: number;
      dur: number;
      z0: number;
      z1: number;
      px0: number;
      py0: number;
      px1: number;
      py1: number;
      /** When set, the tween keeps this screen point fixed (zoom about it). */
      anchor: { sx: number; sy: number } | null;
    };

export type ViewListener = (vp: ViewportController) => void;

export class ViewportController {
  zoom = 1;
  panX = 0;
  panY = 0;
  /** Container size (CSS px). */
  cw = 0;
  ch = 0;
  /** Page size (page units). */
  pw = 0;
  ph = 0;
  /** True while the view is the untouched "fit page" view (re-fit on resize). */
  fitted = true;

  private world: HTMLElement | null = null;
  private frame = 0;
  private lastFrameT = 0;
  private anim: Anim | null = null;
  private listeners = new Set<ViewListener>();
  private lastWritten = '';

  setWorld(el: HTMLElement | null): void {
    this.world = el;
    this.lastWritten = '';
    this.invalidate();
  }

  subscribe(fn: ViewListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get fitZoom(): number {
    if (!(this.pw > 0 && this.ph > 0 && this.cw > 0 && this.ch > 0)) return 1;
    const pad = Math.min(FIT_PADDING, this.cw / 10, this.ch / 10);
    return Math.max(1e-4, Math.min((this.cw - 2 * pad) / this.pw, (this.ch - 2 * pad) / this.ph));
  }
  get minZoom(): number {
    return Math.min(this.fitZoom * 0.25, MAX_ZOOM);
  }
  get maxZoom(): number {
    return MAX_ZOOM;
  }

  clampZoom(z: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, z));
  }

  // ---- coordinate helpers ---------------------------------------------------

  toPage(sx: number, sy: number): Point {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }
  toScreen(p: Point): Point {
    return { x: p.x * this.zoom + this.panX, y: p.y * this.zoom + this.panY };
  }
  /** Visible part of page space (may extend beyond the page). */
  visibleRect(): Rect {
    return { x: -this.panX / this.zoom, y: -this.panY / this.zoom, width: this.cw / this.zoom, height: this.ch / this.zoom };
  }
  isAnimating(): boolean {
    return this.anim !== null;
  }

  /**
   * Where the running zoom animation will end (zoom + visible page rect), or
   * null when not animating. Lets the raster layer start the sharp render for
   * the final view while the animation is still playing.
   */
  targetView(): { zoom: number; visible: Rect } | null {
    const a = this.anim;
    if (!a) return null;
    let z: number;
    let px: number;
    let py: number;
    if (a.kind === 'tween') {
      z = a.z1;
      px = a.px1;
      py = a.py1;
    } else {
      z = a.target;
      const k = z / this.zoom;
      px = a.ax - (a.ax - this.panX) * k;
      py = a.ay - (a.ay - this.panY) * k;
    }
    [px, py] = this.clampedPan(z, px, py);
    return { zoom: z, visible: { x: -px / z, y: -py / z, width: this.cw / z, height: this.ch / z } };
  }

  // ---- mutators -------------------------------------------------------------

  setContainerSize(w: number, h: number): void {
    if (w === this.cw && h === this.ch) return;
    const dw = w - this.cw;
    const dh = h - this.ch;
    const first = this.cw === 0 || this.ch === 0;
    this.cw = w;
    this.ch = h;
    if (this.fitted || first) {
      this.fit(false);
    } else {
      // keep the view centre where it was
      this.panX += dw / 2;
      this.panY += dh / 2;
      this.zoom = this.clampZoom(this.zoom);
      this.clampPan();
      this.invalidate();
    }
  }

  setPageSize(w: number, h: number): void {
    this.pw = w;
    this.ph = h;
  }

  fit(animate = true): void {
    const z = this.fitZoom;
    const px = (this.cw - this.pw * z) / 2;
    const py = (this.ch - this.ph * z) / 2;
    if (animate) this.tweenTo(z, px, py, null);
    else {
      this.anim = null;
      this.zoom = z;
      this.panX = px;
      this.panY = py;
      this.invalidate();
    }
    this.fitted = true;
  }

  /** Immediate zoom about a screen point (pinch, trackpad). */
  zoomAt(factor: number, sx: number, sy: number): void {
    if (this.anim?.kind === 'tween') this.anim = null;
    if (this.anim?.kind === 'smooth') {
      // fold into the running smooth zoom so they don't fight
      this.anim.target = this.clampZoom(this.anim.target * factor);
    }
    this.applyZoomAbout(this.clampZoom(this.zoom * factor), sx, sy);
    this.fitted = false;
    this.invalidate();
  }

  /** Eased zoom about a screen point (mouse-wheel notches). Accumulates. */
  zoomSmooth(factor: number, sx: number, sy: number): void {
    const base = this.anim?.kind === 'smooth' ? this.anim.target : this.zoom;
    this.anim = { kind: 'smooth', target: this.clampZoom(base * factor), ax: sx, ay: sy };
    this.fitted = false;
    this.invalidate();
  }

  /** Animated zoom by a factor about the viewport centre (buttons, keys). */
  zoomBy(factor: number): void {
    const base = this.anim?.kind === 'tween' ? this.anim.z1 : this.anim?.kind === 'smooth' ? this.anim.target : this.zoom;
    this.zoomToAnimated(base * factor);
  }

  zoomToAnimated(z: number): void {
    const z1 = this.clampZoom(z);
    const sx = this.cw / 2;
    const sy = this.ch / 2;
    const k = z1 / this.zoom;
    this.tweenTo(z1, sx - (sx - this.panX) * k, sy - (sy - this.panY) * k, { sx, sy });
    this.fitted = false;
  }

  panBy(dx: number, dy: number): void {
    if (this.anim?.kind === 'tween') this.anim = null;
    this.panX += dx;
    this.panY += dy;
    this.clampPan();
    this.fitted = false;
    this.invalidate();
  }

  // ---- internals ------------------------------------------------------------

  private tweenTo(z1: number, px1: number, py1: number, anchor: { sx: number; sy: number } | null): void {
    this.anim = {
      kind: 'tween',
      t0: performance.now(),
      dur: 180,
      z0: this.zoom,
      z1,
      px0: this.panX,
      py0: this.panY,
      px1,
      py1,
      anchor,
    };
    this.invalidate();
  }

  private applyZoomAbout(z: number, sx: number, sy: number): void {
    const k = z / this.zoom;
    this.panX = sx - (sx - this.panX) * k;
    this.panY = sy - (sy - this.panY) * k;
    this.zoom = z;
    this.clampPan();
  }

  /** Keep at least `m` px of the page inside the viewport. */
  private clampPan(): void {
    [this.panX, this.panY] = this.clampedPan(this.zoom, this.panX, this.panY);
  }

  private clampedPan(zoom: number, px: number, py: number): [number, number] {
    if (!(this.cw > 0 && this.pw > 0)) return [px, py];
    const m = Math.min(80, this.cw / 4, this.ch / 4);
    const sw = this.pw * zoom;
    const sh = this.ph * zoom;
    return [Math.min(this.cw - m, Math.max(m - sw, px)), Math.min(this.ch - m, Math.max(m - sh, py))];
  }

  invalidate(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(this.apply);
  }

  private stepAnim(now: number): void {
    const a = this.anim;
    // Frame-rate independent: a dropped frame advances the animation further.
    const dt = this.lastFrameT ? Math.min(100, Math.max(1, now - this.lastFrameT)) : 16.7;
    this.lastFrameT = now;
    if (!a) return;
    if (a.kind === 'smooth') {
      const ratio = a.target / this.zoom;
      if (Math.abs(Math.log(ratio)) < 0.003) {
        this.applyZoomAbout(a.target, a.ax, a.ay);
        this.anim = null;
      } else {
        // exponential approach in log space: 40% per 60 Hz frame → ~95% in 100 ms, done in ~150 ms
        const k = 1 - Math.pow(0.6, dt / 16.7);
        this.applyZoomAbout(this.zoom * Math.pow(ratio, k), a.ax, a.ay);
      }
      return;
    }
    const t = Math.min(1, (now - a.t0) / a.dur);
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    const z = Math.exp(Math.log(a.z0) + (Math.log(a.z1) - Math.log(a.z0)) * e);
    if (a.anchor) {
      const k = z / a.z0;
      this.panX = a.anchor.sx - (a.anchor.sx - a.px0) * k;
      this.panY = a.anchor.sy - (a.anchor.sy - a.py0) * k;
    } else {
      this.panX = a.px0 + (a.px1 - a.px0) * e;
      this.panY = a.py0 + (a.py1 - a.py0) * e;
    }
    this.zoom = z;
    if (t >= 1) {
      this.zoom = a.z1;
      this.panX = a.px1;
      this.panY = a.py1;
      this.anim = null;
      this.clampPan();
    }
  }

  private apply = (now: number): void => {
    this.frame = 0;
    if (!this.anim) this.lastFrameT = 0; // first frame of a new animation uses a nominal dt
    this.stepAnim(now);
    if (this.anim) this.invalidate();
    const w = this.world;
    if (w) {
      const t = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.zoom})`;
      if (t !== this.lastWritten) {
        w.style.transform = t;
        w.style.setProperty('--inv-zoom', String(1 / this.zoom));
        this.lastWritten = t;
      }
    }
    for (const fn of this.listeners) fn(this);
  };

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.anim = null;
    this.listeners.clear();
    this.world = null;
  }
}
