/**
 * Viewport (app) ↔ PDF user-space transform for export.
 *
 * App geometry: PDF points, origin top-left of the *rotated* page as pdf.js
 * shows it (`page.getViewport({ scale: 1 })`; its view box is CropBox ∩
 * MediaBox). pdf-lib draws in the page's *unrotated* user space with origin
 * bottom-left, so we need the box offset and the /Rotate angle.
 *
 * The mapping equals pdf.js' viewport transform inverted:
 *   rot   0: X = x0 + vx, Y = y1 − vy
 *   rot  90: X = x0 + vy, Y = y0 + vx
 *   rot 180: X = x1 − vx, Y = y0 + vy
 *   rot 270: X = x1 − vy, Y = y1 − vx
 * which is translate(tx, ty) · rotate(rot, CCW) · scale(1, −1) — the same
 * composition pdf-lib's drawSvgPath / drawText(rotate) use.
 */
import type { Point } from '../core/types';

export type Rotation = 0 | 90 | 180 | 270;

export interface PageGeometry {
  rotation: Rotation;
  /** Visible box (CropBox ∩ MediaBox) in unrotated PDF user space, normalised x0<x1, y0<y1. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizeRotation(angle: number): Rotation {
  const r = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return r as Rotation;
}

function norm(b: BoxLike) {
  const xa = b.x, xb = b.x + b.width, ya = b.y, yb = b.y + b.height;
  return { x0: Math.min(xa, xb), x1: Math.max(xa, xb), y0: Math.min(ya, yb), y1: Math.max(ya, yb) };
}

/** Same rule as pdf.js `PDFPage.view`: CropBox ∩ MediaBox, MediaBox when the intersection is empty. */
export function pageGeometry(mediaBox: BoxLike, cropBox: BoxLike | null | undefined, rotationDeg: number): PageGeometry {
  const m = norm(mediaBox);
  let v = m;
  if (cropBox) {
    const c = norm(cropBox);
    const x0 = Math.max(m.x0, c.x0), y0 = Math.max(m.y0, c.y0), x1 = Math.min(m.x1, c.x1), y1 = Math.min(m.y1, c.y1);
    if (x1 > x0 && y1 > y0) v = { x0, y0, x1, y1 };
  }
  return { rotation: normalizeRotation(rotationDeg), ...v };
}

/** Viewport size (rotation applied) — must equal pdf.js viewport width/height at scale 1. */
export function viewportSize(g: PageGeometry): { width: number; height: number } {
  const w = g.x1 - g.x0, h = g.y1 - g.y0;
  return g.rotation === 90 || g.rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

/** Translation + CCW rotation such that PDF = T · R(rot) · (vx, −vy). */
export function placement(g: PageGeometry): { tx: number; ty: number; rotate: Rotation } {
  switch (g.rotation) {
    case 0:
      return { tx: g.x0, ty: g.y1, rotate: 0 };
    case 90:
      return { tx: g.x0, ty: g.y0, rotate: 90 };
    case 180:
      return { tx: g.x1, ty: g.y0, rotate: 180 };
    case 270:
      return { tx: g.x1, ty: g.y1, rotate: 270 };
  }
}

export function viewportToPdf(g: PageGeometry, p: Point): Point {
  const { x: vx, y: vy } = p;
  switch (g.rotation) {
    case 0:
      return { x: g.x0 + vx, y: g.y1 - vy };
    case 90:
      return { x: g.x0 + vy, y: g.y0 + vx };
    case 180:
      return { x: g.x1 - vx, y: g.y0 + vy };
    case 270:
      return { x: g.x1 - vy, y: g.y1 - vx };
  }
}

export function pdfToViewport(g: PageGeometry, p: Point): Point {
  const { x: X, y: Y } = p;
  switch (g.rotation) {
    case 0:
      return { x: X - g.x0, y: g.y1 - Y };
    case 90:
      return { x: Y - g.y0, y: X - g.x0 };
    case 180:
      return { x: g.x1 - X, y: Y - g.y0 };
    case 270:
      return { x: g.y1 - Y, y: g.x1 - X };
  }
}
