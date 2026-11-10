/**
 * Build-time patch of pdf.js' display layer (pdfjs-dist/build/pdf.mjs), applied by a tiny Vite
 * plugin (dev server, app bundle and worker bundle alike). Imported from vite.config.ts only.
 *
 * rescaleAndStroke: for every hairline stroke (line thinner than one device pixel — i.e. almost
 * every line of a CAD drawing at overview zoom) pdf.js wraps `ctx.scale(); ctx.stroke()` in
 * `ctx.save()` / `ctx.restore()`. Each save() allocates a full canvas-state copy in the engine's
 * C++ GC heap, which the JS GC does not account for: a 900k-path drawing piled up hundreds of MB
 * of garbage per render (see ctxTransform.ts). With no dash pattern, only the transform changes
 * between save and restore, so we put the transform back directly instead.
 *
 * The patch is exact-match: if pdf.js changes this code the build fails loudly (see the test)
 * rather than silently shipping without it.
 */
import type { Plugin } from 'vite';

const ORIGINAL = `    const dashes = ctx.getLineDash();
    if (saveRestore) {
      ctx.save();
    }
    ctx.scale(scaleX, scaleY);`;

const PATCHED = `    const dashes = ctx.getLineDash();
    if (saveRestore && dashes.length === 0) {
      /* pdf-viewer patch (pdfjsPatchPlugin.ts): no save()/restore() per hairline stroke */
      const savedTransform = ctx.getTransform();
      ctx.scale(scaleX, scaleY);
      ctx.stroke();
      ctx.setTransform(savedTransform);
      return;
    }
    if (saveRestore) {
      ctx.save();
    }
    ctx.scale(scaleX, scaleY);`;

/** The pdf.js display-layer module the app imports ('pdfjs-dist' → build/pdf.mjs). */
export const PDFJS_DISPLAY_RE = /[\\/]pdfjs-dist[\\/]build[\\/]pdf\.mjs$/;

/** Returns the patched source; throws if the code to patch is not found exactly once. */
export function patchPdfjsDisplay(code: string): string {
  const n = code.split(ORIGINAL).length - 1;
  if (n !== 1) throw new Error(`pdfjs patch: rescaleAndStroke pattern found ${n} times (pdf.js changed? update pdfjsPatchPlugin.ts)`);
  return code.replace(ORIGINAL, PATCHED);
}

export function pdfjsPatchPlugin(): Plugin {
  return {
    name: 'pdfjs-display-patch',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!PDFJS_DISPLAY_RE.test(file)) return null;
      return { code: patchPdfjsDisplay(code), map: null };
    },
  };
}
