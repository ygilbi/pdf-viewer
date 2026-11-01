import type { PageSize, PdfClient, Rect, RenderResult, RenderTask } from '../../core/types';

/**
 * PDF raster layers of the viewer, managed imperatively (no React).
 *
 * Layer 1 — BASE: one full-page bitmap per page (longest side ≈ 2048 px,
 *   more on HiDPI screens, ≤ 3072), cached per page (LRU). There is no
 *   low-res preview pass: for vector drawings the cost of a render is walking
 *   the operator list, not pixels, so a 512 px preview costs almost as much
 *   as the base and only delays it. Once the visible base is up, the
 *   neighbouring pages' bases are prefetched (low priority) so next/previous
 *   is instant, and an in-flight prefetch is adopted (re-prioritised) when the
 *   user switches to that page. Drawn into a 2D canvas CSS-scaled to the page.
 *
 * Layer 2 — SHARP: the visible part of the page (+ margin) rendered at
 *   zoom × devicePixelRatio as ONE region bitmap placed exactly over that
 *   region. Why one region instead of a 512 px tile grid: pdf.js cost per
 *   render call is dominated by walking the page's whole operator list (every
 *   vector path is interpreted even if clipped away), so N tiles ≈ N × the
 *   work of one region render. The render for the *final* view of a zoom
 *   animation starts while the animation still plays (see ViewerCanvas), and
 *   after it lands a larger "halo" region at the same scale is rendered in
 *   the background so short pans stay sharp. The last few region bitmaps are
 *   kept (LRU, pixel budget) so panning / zooming back is instant; sharper
 *   regions stack on top.
 *
 *   Region (and hi-res) canvases use a `bitmaprenderer` context, so the
 *   ImageBitmap from the worker is handed to the compositor without a copy.
 *   Canvases are positioned with transforms (float precision) rather than
 *   left/top (layout units are 1/64 px, which would be visible at 64× zoom).
 *
 * Priorities (higher first; the worker resumes the most urgent render slice
 * first, so background work pauses while a visible render runs).
 */

const MAX_TILES = 8;
const TILE_PIXEL_BUDGET = 36 * 1024 * 1024;
const MAX_SIDE = 4096;
const MAX_PIXELS = 16 * 1024 * 1024;
const HALO_PIXELS = 12 * 1024 * 1024;
const BASE_CACHE_PAGES = 5;

const PRIO_SHARP = 90;
const PRIO_BASE = 80;
const PRIO_HALO = 40;
const PRIO_PREFETCH = 30;
// (thumbnails use 0)

interface CachedBitmap {
  bitmap: ImageBitmap;
}

interface Tile {
  canvas: HTMLCanvasElement;
  scale: number;
  region: Rect;
  pixels: number;
  used: number;
  shown: boolean;
}

interface Inflight {
  task: RenderTask;
  page: number;
  scale: number;
  region: Rect;
}

interface Plan {
  scale: number;
  region: Rect;
  /** Visible ∩ page — what must be covered. */
  need: Rect;
  desired: number;
}

interface View {
  zoom: number;
  visible: Rect;
}

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

function contains(outer: Rect, inner: Rect, eps = 1e-3): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.width <= outer.x + outer.width + eps &&
    inner.y + inner.height <= outer.y + outer.height + eps
  );
}

/**
 * Does tile `t` cover `r`? Tolerance of one output pixel: a tile's extent is
 * its whole-pixel bitmap size / scale, which at the page's right/bottom edge
 * ends a fraction of a pixel short of the page (the view would otherwise never
 * count as covered there and be re-rendered on every settle).
 */
function covers(t: { region: Rect; scale: number }, r: Rect): boolean {
  return contains(t.region, r, Math.max(1e-3, 1 / t.scale));
}

class LRU<V extends CachedBitmap> {
  private map = new Map<number, V>();
  constructor(private limit: number) {}
  get(k: number): V | undefined {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: number, v: V): void {
    const old = this.map.get(k);
    if (old && old !== v) old.bitmap.close();
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.limit) {
      const [oldestKey, oldest] = this.map.entries().next().value as [number, V];
      this.map.delete(oldestKey);
      oldest.bitmap.close();
    }
  }
  has(k: number): boolean {
    return this.map.has(k);
  }
  clear(): void {
    for (const v of this.map.values()) v.bitmap.close();
    this.map.clear();
  }
}

export function baseLongSide(): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.round(Math.min(3072, 2048 * Math.max(1, Math.min(dpr, 1.5))));
}

function snapToGrid(region: Rect, scale: number, pw: number, ph: number): Rect {
  const x0 = Math.floor(region.x * scale) / scale;
  const y0 = Math.floor(region.y * scale) / scale;
  const x1 = Math.min(Math.ceil((region.x + region.width) * scale) / scale, Math.max(pw, x0 + 1 / scale));
  const y1 = Math.min(Math.ceil((region.y + region.height) * scale) / scale, Math.max(ph, y0 + 1 / scale));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const fitsCanvas = (r: Rect, s: number, maxPixels = MAX_PIXELS) =>
  r.width * s <= MAX_SIDE && r.height * s <= MAX_SIDE && r.width * r.height * s * s <= maxPixels;

export class PageLayers {
  private docKey: unknown = undefined;
  private sizes: PageSize[] = [];
  private page = 0;
  private size: PageSize = { width: 0, height: 0 };
  private baseScale = 1;
  /** 0 = nothing drawn, 2 = full base (1 was the old preview level). */
  private baseLevel = 0;
  /** Base renders in flight, by page (the current page and prefetches). */
  private baseInflight = new Map<number, { task: RenderTask; scale: number }>();
  private baseCache = new LRU<CachedBitmap>(BASE_CACHE_PAGES);
  private tiles: Tile[] = [];
  private inflight: Inflight | null = null;
  private halo: Inflight | null = null;
  private lastView: View | null = null;
  private useCounter = 0;
  private destroyed = false;
  /** Called when a new sharp tile is shown (for tests / debugging). */
  onTile: ((t: { scale: number; region: Rect }) => void) | null = null;

  constructor(
    private client: PdfClient,
    private baseCanvas: HTMLCanvasElement,
    private tileHost: HTMLElement,
  ) {
    baseCanvas.style.visibility = 'hidden';
  }

  get currentBaseScale(): number {
    return this.baseScale;
  }
  get tileCount(): number {
    return this.tiles.length;
  }
  /** 0 = nothing drawn, 2 = full base. */
  get baseQuality(): number {
    return this.baseLevel;
  }

  /**
   * True when what is on screen is as sharp as it is going to get for this
   * view: the full base when it suffices, otherwise a shown
   * sharp tile at the planned scale covering the visible part of the page.
   * (Benchmarks / tests.)
   */
  isSharp(zoom: number, visible: Rect): boolean {
    if (!this.page || this.baseLevel < 2) return false;
    const plan = this.plan(zoom, visible);
    if (!plan) return true;
    return this.tiles.some((t) => t.shown && t.scale >= plan.scale * 0.98 && covers(t, plan.need));
  }

  /**
   * Show `page`. `docKey` identifies the open document (caches reset when it
   * changes); `sizes` (all page sizes) enables prefetching the neighbours.
   */
  setPage(docKey: unknown, page: number, size: PageSize, sizes?: PageSize[]): void {
    if (docKey !== this.docKey) {
      this.docKey = docKey;
      this.baseCache.clear();
      this.cancelAllBase();
    }
    this.sizes = sizes ?? [];
    this.cancelSharp();
    this.cancelHalo();
    this.clearTiles();
    this.lastView = null;
    this.page = page;
    this.size = size;
    this.baseLevel = 0;
    mark('viewer:setPage');
    // Keep prefetches that are still useful (neighbours), drop the rest.
    for (const [p, f] of [...this.baseInflight]) {
      if (Math.abs(p - page) > 1) {
        f.task.cancel();
        this.baseInflight.delete(p);
      }
    }
    const longest = Math.max(size.width, size.height);
    if (!(longest > 0)) return;
    this.baseScale = baseLongSide() / longest;

    const full = this.baseCache.get(page);
    if (full) {
      this.drawBase(full.bitmap);
      this.startBackground();
      return;
    }
    this.baseCanvas.style.visibility = 'hidden';
    const pending = this.baseInflight.get(page);
    if (pending && Math.abs(pending.scale / this.baseScale - 1) < 0.01) {
      pending.task.setPriority?.(PRIO_BASE); // adopt the prefetch
    } else {
      pending?.task.cancel();
      this.requestBase(page, this.baseScale, PRIO_BASE);
    }
  }

  /** Remove everything (no document). */
  clear(): void {
    this.cancelAllBase();
    this.cancelSharp();
    this.cancelHalo();
    this.clearTiles();
    this.page = 0;
    this.baseLevel = 0;
    this.lastView = null;
    this.baseCanvas.style.visibility = 'hidden';
  }

  /**
   * Cheap; called on every view frame. `target` is where a running zoom
   * animation will end. Cancels a sharp render that serves neither the
   * current nor the target view, and hides tiles that would be heavily
   * minified (GPU scaling has no mipmaps → thin lines would shimmer/alias;
   * the base layer is better).
   */
  viewChanged(zoom: number, visible: Rect, target?: View | null): void {
    if (!this.page) return;
    this.lastView = { zoom, visible };
    this.updateVisibility();
    if (this.inflight) {
      const plan = this.plan(zoom, visible);
      const tplan = target ? this.plan(target.zoom, target.visible) : null;
      const f = this.inflight;
      const keep =
        (plan && this.inflightServes(f, plan)) ||
        (tplan && this.inflightServes(f, tplan)) ||
        // Panning at the same zoom: a render that still overlaps the view is worth finishing.
        (!target && plan && Math.abs(f.scale / plan.scale - 1) < 0.02 && !!intersect(f.region, plan.need));
      if (!keep) this.cancelSharp();
    }
    if (this.halo) {
      // A halo stays useful while panning at the same zoom; drop it on zoom.
      const plan = this.plan(target?.zoom ?? zoom, target?.visible ?? visible);
      if (!plan || Math.abs(this.halo.scale / plan.scale - 1) > 0.02 || !intersect(this.halo.region, plan.need)) {
        this.cancelHalo();
      }
    }
  }

  /**
   * Make `visible` at `zoom` sharp: called when the view settles, and with
   * the target view while a zoom animation is still running.
   */
  settle(zoom: number, visible: Rect): void {
    if (!this.page || this.destroyed) return;
    const plan = this.plan(zoom, visible);
    if (!plan) {
      this.cancelSharp();
      return;
    }
    const covering = this.tiles.find(
      (t) => t.scale >= plan.scale * 0.98 && t.scale <= plan.desired * 3 && covers(t, plan.need),
    );
    if (covering) {
      covering.used = ++this.useCounter;
      this.startHalo(plan.scale, { zoom, visible });
      return;
    }
    if (this.inflight && this.inflightServes(this.inflight, plan)) return;
    if (this.halo && this.inflightServes(this.halo, plan)) {
      this.halo.task.setPriority?.(PRIO_SHARP); // the background halo is exactly what we need now
      return;
    }
    this.cancelSharp();

    const page = this.page;
    mark('viewer:sharp-req');
    const task = this.client.render({ page, scale: plan.scale, region: plan.region, priority: PRIO_SHARP });
    const entry: Inflight = { task, page, scale: plan.scale, region: plan.region };
    this.inflight = entry;
    task.promise.then(
      (r) => {
        if (this.inflight === entry) this.inflight = null;
        if (this.destroyed || r.page !== this.page || entry.page !== this.page) {
          r.bitmap.close();
          return;
        }
        this.addTile(r);
        this.startHalo(r.scale);
      },
      (e) => {
        if (this.inflight === entry) this.inflight = null;
        if (!isAbort(e)) console.warn('[viewer] sharp render failed', e);
      },
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.clear();
    this.baseCache.clear();
  }

  // ---- internals ------------------------------------------------------------

  private plan(zoom: number, visible: Rect): Plan | null {
    const { width: pw, height: ph } = this.size;
    const pageRect = { x: 0, y: 0, width: pw, height: ph };
    const desired = zoom * dpr();
    if (desired <= this.baseScale * 1.05) return null; // base layer is already sharp enough
    const need = intersect(visible, pageRect);
    if (!need) return null;

    const mx = visible.width * 0.15;
    const my = visible.height * 0.15;
    let region =
      intersect({ x: visible.x - mx, y: visible.y - my, width: visible.width + 2 * mx, height: visible.height + 2 * my }, pageRect) ??
      need;
    let scale = desired;
    if (!fitsCanvas(region, scale)) {
      region = need; // drop the margin before dropping resolution
      if (!fitsCanvas(region, scale)) {
        scale = Math.min(scale, MAX_SIDE / region.width, MAX_SIDE / region.height, Math.sqrt(MAX_PIXELS / (region.width * region.height)));
        scale *= 0.999;
      }
    }
    if (scale <= this.baseScale * 1.05) return null;
    // Snap the region to the output pixel grid so bitmap pixels map 1:1.
    return { scale, region: snapToGrid(region, scale, pw, ph), need, desired };
  }

  private inflightServes(f: Inflight, plan: Plan): boolean {
    return Math.abs(f.scale / plan.scale - 1) < 0.02 && contains(f.region, plan.need);
  }

  /** After a sharp tile: render a larger region at the same scale in the background. */
  private startHalo(scale: number, view: View | null = this.lastView): void {
    const v = view;
    if (!v || this.halo || this.inflight) return;
    const plan = this.plan(v.zoom, v.visible);
    if (!plan || Math.abs(plan.scale / scale - 1) > 0.02) return;
    const { width: pw, height: ph } = this.size;
    const pageRect = { x: 0, y: 0, width: pw, height: ph };
    const vis = v.visible;
    // Up to half a viewport on each side, shrunk to the pixel budget.
    let f = 0.5;
    let region: Rect | null = null;
    while (f >= 0.2) {
      region = intersect(
        { x: vis.x - vis.width * f, y: vis.y - vis.height * f, width: vis.width * (1 + 2 * f), height: vis.height * (1 + 2 * f) },
        pageRect,
      );
      if (region && fitsCanvas(region, scale, HALO_PIXELS)) break;
      region = null;
      f -= 0.1;
    }
    if (!region) return;
    const covered = this.tiles.find((t) => t.scale >= scale * 0.98 && covers(t, region!));
    const best = this.tiles.filter((t) => Math.abs(t.scale / scale - 1) < 0.02).reduce((a, t) => Math.max(a, t.region.width * t.region.height), 0);
    if (covered || region.width * region.height < best * 1.3) return;
    region = snapToGrid(region, scale, pw, ph);
    const page = this.page;
    const task = this.client.render({ page, scale, region, priority: PRIO_HALO });
    const entry: Inflight = { task, page, scale, region };
    this.halo = entry;
    task.promise.then(
      (r) => {
        if (this.halo === entry) this.halo = null;
        if (this.destroyed || r.page !== this.page) {
          r.bitmap.close();
          return;
        }
        this.addTile(r);
      },
      (e) => {
        if (this.halo === entry) this.halo = null;
        if (!isAbort(e)) console.warn('[viewer] halo render failed', e);
      },
    );
  }

  private requestBase(page: number, scale: number, priority: number): void {
    const task = this.client.render({ page, scale, priority });
    const entry = { task, scale };
    this.baseInflight.set(page, entry);
    task.promise.then(
      (r) => {
        if (this.baseInflight.get(page) === entry) this.baseInflight.delete(page);
        if (this.destroyed) {
          r.bitmap.close();
          return;
        }
        this.baseCache.set(r.page, { bitmap: r.bitmap }); // cache takes ownership
        if (r.page === this.page && this.baseLevel < 2) {
          this.drawBase(r.bitmap);
          this.startBackground();
        }
      },
      (e) => {
        if (this.baseInflight.get(page) === entry) this.baseInflight.delete(page);
        if (!isAbort(e)) console.warn('[viewer] base render failed', e);
      },
    );
  }

  /** Low-priority work once the visible page's base is up: prefetch the neighbours' bases. */
  private startBackground(): void {
    const page = this.page;
    for (const p of [page + 1, page - 1]) {
      const sz = this.sizes[p - 1];
      if (!sz || this.baseInflight.has(p) || this.baseCache.has(p)) continue;
      const longest = Math.max(sz.width, sz.height);
      if (longest > 0) this.requestBase(p, baseLongSide() / longest, PRIO_PREFETCH);
    }
  }

  private drawBase(bitmap: ImageBitmap): void {
    const c = this.baseCanvas;
    if (c.width !== bitmap.width || c.height !== bitmap.height) {
      c.width = bitmap.width;
      c.height = bitmap.height;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(bitmap, 0, 0);
    c.style.width = `${bitmap.width}px`;
    c.style.height = `${bitmap.height}px`;
    c.style.transform = `scale(${this.size.width / bitmap.width}, ${this.size.height / bitmap.height})`;
    c.style.visibility = 'visible';
    this.baseLevel = 2;
    mark('viewer:base');
  }

  /** A canvas holding `bitmap` without a copy (bitmaprenderer), positioned at the origin. */
  private makeBitmapCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('bitmaprenderer');
    const w = bitmap.width;
    const h = bitmap.height;
    if (ctx) ctx.transferFromImageBitmap(bitmap);
    else {
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
    }
    const s = canvas.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.transformOrigin = '0 0';
    s.pointerEvents = 'none';
    return canvas;
  }

  private addTile(r: RenderResult): void {
    const w = r.bitmap.width;
    const h = r.bitmap.height;
    const canvas = this.makeBitmapCanvas(r.bitmap);
    const region = { x: r.region.x, y: r.region.y, width: w / r.scale, height: h / r.scale };
    const s = canvas.style;
    s.width = `${w}px`;
    s.height = `${h}px`;
    s.transform = `translate(${region.x}px, ${region.y}px) scale(${1 / r.scale})`;
    const tile: Tile = { canvas, scale: r.scale, region, pixels: w * h, used: ++this.useCounter, shown: true };

    // Drop tiles that the new one makes redundant (fully covered, not sharper).
    for (const t of [...this.tiles]) {
      if (t.scale <= tile.scale * 1.001 && contains(tile.region, t.region)) this.removeTile(t);
    }
    this.tiles.push(tile);
    this.tileHost.appendChild(canvas);
    // Budget: evict least-recently-used (never the new one).
    let total = this.tiles.reduce((a, t) => a + t.pixels, 0);
    while (this.tiles.length > MAX_TILES || total > TILE_PIXEL_BUDGET) {
      // Prefer tiles that others already cover (e.g. overlapping slivers left by
      // renders during a pan), so a distinct view the user may return to survives.
      const candidates = this.tiles.filter((t) => t !== tile).sort((a, b) => a.used - b.used);
      const victim = candidates.find((t) => this.isRedundant(t)) ?? candidates[0];
      if (!victim) break;
      total -= victim.pixels;
      this.removeTile(victim);
    }
    // Sharper tiles on top.
    [...this.tiles].sort((a, b) => a.scale - b.scale).forEach((t, i) => (t.canvas.style.zIndex = String(i + 1)));
    this.updateVisibility();
    this.onTile?.({ scale: tile.scale, region });
    mark('viewer:tile');
  }

  /** True if other tiles at ≥ this scale cover all of `t` (5×5 sample points). */
  private isRedundant(t: Tile): boolean {
    const others = this.tiles.filter((o) => o !== t && o.scale >= t.scale * 0.98);
    if (others.length === 0) return false;
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        const x = t.region.x + (t.region.width * (i + 0.5)) / 5;
        const y = t.region.y + (t.region.height * (j + 0.5)) / 5;
        if (!others.some((o) => x >= o.region.x && x <= o.region.x + o.region.width && y >= o.region.y && y <= o.region.y + o.region.height)) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Show only what can be seen: tiles that would be heavily minified are
   * hidden (GPU scaling has no mipmaps → thin lines would shimmer; the base is
   * better), and tiles / the base fully covered (within the view) by a sharper
   * shown tile are hidden too, so the compositor doesn't blend several large
   * layers on every frame of a zoom or pan.
   */
  private updateVisibility(): void {
    const v = this.lastView;
    const desired = (v?.zoom ?? 0) * dpr();
    const pageRect = { x: 0, y: 0, width: this.size.width, height: this.size.height };
    const need = v ? intersect(v.visible, pageRect) : null;
    const shown: Tile[] = [];
    for (const t of [...this.tiles].sort((a, b) => b.scale - a.scale)) {
      let on = !v || t.scale <= desired * 3;
      if (on && need) {
        const part = intersect(t.region, need);
        on = !!part && !shown.some((o) => covers(o, part));
      }
      this.setShown(t, on);
      if (on) shown.push(t);
    }
    const baseCovered = !!need && shown.some((o) => covers(o, need));
    const vis = this.baseLevel >= 2 && !baseCovered ? 'visible' : 'hidden';
    if (this.baseCanvas.style.visibility !== vis) this.baseCanvas.style.visibility = vis;
  }

  private setShown(t: Tile, shown: boolean): void {
    if (t.shown === shown) return;
    t.shown = shown;
    t.canvas.style.display = shown ? '' : 'none';
  }

  private removeTile(t: Tile): void {
    releaseCanvas(t.canvas);
    this.tiles = this.tiles.filter((x) => x !== t);
  }

  private clearTiles(): void {
    for (const t of this.tiles) releaseCanvas(t.canvas);
    this.tiles = [];
  }

  private cancelAllBase(): void {
    for (const f of this.baseInflight.values()) f.task.cancel();
    this.baseInflight.clear();
  }

  private cancelSharp(): void {
    this.inflight?.task.cancel();
    this.inflight = null;
  }

  private cancelHalo(): void {
    this.halo?.task.cancel();
    this.halo = null;
  }
}

/** Detach a raster canvas and free its pixels now rather than at GC. */
function releaseCanvas(c: HTMLCanvasElement): void {
  c.remove();
  const br = c.getContext('bitmaprenderer');
  if (br) br.transferFromImageBitmap(null);
  else c.width = c.height = 0;
}

function dpr(): number {
  return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    /* ignore */
  }
}
