import type { PageSize, PdfClient, Rect, RenderResult, RenderTask } from '../../core/types';

/**
 * PDF raster layers of the viewer, managed imperatively (no React).
 *
 * Layer 1 — BASE: one full-page bitmap per page (longest side ≈ 2048 px,
 *   more on HiDPI screens, ≤ 3072), preceded by an instant ~512 px preview
 *   pass. Both are cached per page (LRU) so page switches are instant.
 *   Drawn into a 2D canvas that is CSS-scaled to exactly cover the page.
 *
 * Layer 2 — SHARP: when the view settles, the visible part of the page
 *   (+ margin) is rendered at zoom × devicePixelRatio as ONE region bitmap and
 *   placed exactly over that region. Why one region instead of a 512 px tile
 *   grid: pdf.js cost per render call is dominated by walking the page's whole
 *   operator list (every vector path of a 50 MB drawing is interpreted even if
 *   it is clipped away), so N tiles ≈ N × the work of one region render. A
 *   single region render gets the screen sharp in the shortest time. To still
 *   get some of the reuse benefit of tiles, the last few region bitmaps are
 *   kept (LRU, pixel budget) so panning back / zooming back between recently
 *   seen views is instant; higher-resolution regions stack on top.
 *
 *   Each region canvas uses a `bitmaprenderer` context, so the ImageBitmap
 *   from the worker is handed to the compositor without a copy. Canvases are
 *   positioned with transforms (float precision) rather than left/top
 *   (layout units are 1/64 px, which would be visible at 64× zoom).
 */

const PREVIEW_LONG_SIDE = 512;
const MAX_TILES = 4;
const TILE_PIXEL_BUDGET = 36 * 1024 * 1024;
const MAX_SIDE = 4096;
const MAX_PIXELS = 16 * 1024 * 1024;
const BASE_CACHE_PAGES = 4;
const PREVIEW_CACHE_PAGES = 48;

const PRIO_PREVIEW = 100;
const PRIO_SHARP = 90;
const PRIO_BASE = 80;

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
  clear(): void {
    for (const v of this.map.values()) v.bitmap.close();
    this.map.clear();
  }
}

export function baseLongSide(): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.round(Math.min(3072, 2048 * Math.max(1, Math.min(dpr, 1.5))));
}

export class PageLayers {
  private docKey: unknown = undefined;
  private page = 0;
  private size: PageSize = { width: 0, height: 0 };
  private baseScale = 1;
  /** 0 = nothing drawn, 1 = preview, 2 = full base. */
  private baseLevel = 0;
  private baseTasks: RenderTask[] = [];
  private baseCache = new LRU<CachedBitmap>(BASE_CACHE_PAGES);
  private previewCache = new LRU<CachedBitmap>(PREVIEW_CACHE_PAGES);
  private tiles: Tile[] = [];
  private inflight: Inflight | null = null;
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

  /** Show `page`. `docKey` identifies the open document (caches reset when it changes). */
  setPage(docKey: unknown, page: number, size: PageSize): void {
    if (docKey !== this.docKey) {
      this.docKey = docKey;
      this.baseCache.clear();
      this.previewCache.clear();
    }
    this.cancelBase();
    this.cancelSharp();
    this.clearTiles();
    this.page = page;
    this.size = size;
    this.baseLevel = 0;
    const longest = Math.max(size.width, size.height);
    if (!(longest > 0)) return;
    this.baseScale = baseLongSide() / longest;

    const full = this.baseCache.get(page);
    if (full) {
      this.drawBase(full.bitmap, 2);
      return;
    }
    const prev = this.previewCache.get(page);
    if (prev) this.drawBase(prev.bitmap, 1);
    else {
      this.baseCanvas.style.visibility = 'hidden';
      this.requestBase(PREVIEW_LONG_SIDE / longest, PRIO_PREVIEW, (r) => {
        this.previewCache.set(r.page, { bitmap: r.bitmap });
        if (r.page === this.page && this.baseLevel < 1) this.drawBase(r.bitmap, 1);
      });
    }
    this.requestBase(this.baseScale, PRIO_BASE, (r) => {
      this.baseCache.set(r.page, { bitmap: r.bitmap });
      if (r.page === this.page) this.drawBase(r.bitmap, 2);
    });
  }

  /** Remove everything (no document). */
  clear(): void {
    this.cancelBase();
    this.cancelSharp();
    this.clearTiles();
    this.page = 0;
    this.baseLevel = 0;
    this.baseCanvas.style.visibility = 'hidden';
  }

  /**
   * Cheap; called on every view frame. Cancels a now-stale in-flight sharp
   * render and hides tiles that would be heavily minified (GPU scaling has
   * no mipmaps → thin lines would shimmer/alias; the base layer is better).
   */
  viewChanged(zoom: number, visible: Rect): void {
    if (!this.page) return;
    const desired = zoom * dpr();
    for (const t of this.tiles) this.setShown(t, t.scale <= desired * 3);
    if (this.inflight) {
      const plan = this.plan(zoom, visible);
      if (!plan || !this.inflightServes(plan)) this.cancelSharp();
    }
  }

  /** Called once the view has settled: make the visible area sharp. */
  settle(zoom: number, visible: Rect): void {
    if (!this.page || this.destroyed) return;
    const plan = this.plan(zoom, visible);
    if (!plan) {
      this.cancelSharp();
      return;
    }
    const covering = this.tiles.find(
      (t) => t.scale >= plan.scale * 0.98 && t.scale <= plan.desired * 3 && contains(t.region, plan.need),
    );
    if (covering) {
      covering.used = ++this.useCounter;
      return;
    }
    if (this.inflight && this.inflightServes(plan)) return;
    this.cancelSharp();

    const page = this.page;
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
    this.previewCache.clear();
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
    const fits = (r: Rect, s: number) => r.width * s <= MAX_SIDE && r.height * s <= MAX_SIDE && r.width * r.height * s * s <= MAX_PIXELS;
    if (!fits(region, scale)) {
      region = need; // drop the margin before dropping resolution
      if (!fits(region, scale)) {
        scale = Math.min(scale, MAX_SIDE / region.width, MAX_SIDE / region.height, Math.sqrt(MAX_PIXELS / (region.width * region.height)));
        scale *= 0.999;
      }
    }
    if (scale <= this.baseScale * 1.05) return null;
    // Snap the region to the output pixel grid so bitmap pixels map 1:1.
    const x0 = Math.floor(region.x * scale) / scale;
    const y0 = Math.floor(region.y * scale) / scale;
    const x1 = Math.min(Math.ceil((region.x + region.width) * scale) / scale, Math.max(pw, x0 + 1 / scale));
    const y1 = Math.min(Math.ceil((region.y + region.height) * scale) / scale, Math.max(ph, y0 + 1 / scale));
    return { scale, region: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, need, desired };
  }

  private inflightServes(plan: Plan): boolean {
    const f = this.inflight;
    if (!f) return false;
    return Math.abs(f.scale / plan.scale - 1) < 0.02 && contains(f.region, plan.need);
  }

  private requestBase(scale: number, priority: number, onDone: (r: RenderResult) => void): void {
    const page = this.page;
    const task = this.client.render({ page, scale, priority });
    this.baseTasks.push(task);
    task.promise.then(
      (r) => {
        this.baseTasks = this.baseTasks.filter((t) => t !== task);
        if (this.destroyed) {
          r.bitmap.close();
          return;
        }
        onDone(r); // caches take ownership of the bitmap
      },
      (e) => {
        this.baseTasks = this.baseTasks.filter((t) => t !== task);
        if (!isAbort(e)) console.warn('[viewer] base render failed', e);
      },
    );
  }

  private drawBase(bitmap: ImageBitmap, level: number): void {
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
    this.baseLevel = level;
  }

  private addTile(r: RenderResult): void {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('bitmaprenderer');
    const w = r.bitmap.width;
    const h = r.bitmap.height;
    if (ctx) ctx.transferFromImageBitmap(r.bitmap);
    else {
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')?.drawImage(r.bitmap, 0, 0);
      r.bitmap.close();
    }
    const region = { x: r.region.x, y: r.region.y, width: w / r.scale, height: h / r.scale };
    const s = canvas.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.width = `${w}px`;
    s.height = `${h}px`;
    s.transformOrigin = '0 0';
    s.transform = `translate(${region.x}px, ${region.y}px) scale(${1 / r.scale})`;
    s.pointerEvents = 'none';
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
      const victim = this.tiles.filter((t) => t !== tile).sort((a, b) => a.used - b.used)[0];
      if (!victim) break;
      total -= victim.pixels;
      this.removeTile(victim);
    }
    // Sharper tiles on top.
    [...this.tiles].sort((a, b) => a.scale - b.scale).forEach((t, i) => (t.canvas.style.zIndex = String(i + 1)));
    this.onTile?.({ scale: tile.scale, region });
  }

  private setShown(t: Tile, shown: boolean): void {
    if (t.shown === shown) return;
    t.shown = shown;
    t.canvas.style.display = shown ? '' : 'none';
  }

  private removeTile(t: Tile): void {
    t.canvas.remove();
    this.tiles = this.tiles.filter((x) => x !== t);
  }

  private clearTiles(): void {
    for (const t of this.tiles) t.canvas.remove();
    this.tiles = [];
  }

  private cancelBase(): void {
    for (const t of this.baseTasks) t.cancel();
    this.baseTasks = [];
  }

  private cancelSharp(): void {
    this.inflight?.task.cancel();
    this.inflight = null;
  }
}

function dpr(): number {
  return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
}
