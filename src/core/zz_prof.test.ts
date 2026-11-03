import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractSegments, buildSnapPoints } from './vectorSnap';
it('prof', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const f of ['/home/user/pdf-viewer/public/demo-facade.pdf', '/tmp/claude-0/-home-user/c2780c8d-551e-5f2b-a8b3-b1340a2fac51/scratchpad/sample-heavy.pdf']) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(f)) }).promise;
    const page = await doc.getPage(1);
    const ol = await page.getOperatorList({ annotationMode: 0 });
    const vt = page.getViewport({ scale: 1 }).transform;
    const ex = extractSegments(ol.fnArray, ol.argsArray, pdfjs.OPS as never, vt);
    for (const lim of [{ maxIntersections: 0 }, {}]) for (let k = 0; k < 3; k++) {
      const t1 = performance.now();
      const r = buildSnapPoints(ex, lim);
      console.log(f.split('/').pop(), JSON.stringify(lim), 'pts', r.count, 'build', (performance.now() - t1).toFixed(1));
    }
  }
}, 60000);
