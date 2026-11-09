import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { quadRect, substringRect, toTextItem, toTextItems, viewportTransform } from './textGeometry';
import {
  POINTS_PER_METER,
  calibrationFromScale,
  detectPaperSize,
  detectScales,
  formatPaper,
  parseScaleNotations,
  ppmForScale,
} from './scaleDetect';
import { buildMatcher, detectTags, findInItems, DEFAULT_SEARCH_OPTIONS } from './textSearch';
import type { TextItem } from '../core/types';
import { lengthMeters } from '../core/measurementEngine';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** Item helper: horizontal run at user-space (x, y) baseline, font size fs, advance w. */
const run = (str: string, x: number, y: number, fs: number, w: number) => ({ str, transform: [fs, 0, 0, fs, x, y], width: w, height: fs });

describe('viewportTransform (matches pdf.js PageViewport)', () => {
  it('rotation 0 and 90 for an A2 landscape page', () => {
    // values printed by pdf.js 4.10 page.getViewport({ scale: 1, rotation }) for demo-facade.pdf
    expect(viewportTransform([0, 0, 1683.78, 1190.551], 0)).toEqual([1, 0, 0, -1, 0, 1190.551]);
    expect(viewportTransform([0, 0, 1683.78, 1190.551], 90).map((v) => v + 0)).toEqual([0, 1, 1, 0, 0, 0]);
  });
});

describe('text item bbox in page units', () => {
  const view = [0, 0, 600, 400];

  it('rotation 0: y flips, box spans ascent above / descent below the baseline', () => {
    const vt = viewportTransform(view, 0);
    const t = toTextItem(vt, run('W1', 100, 300, 10, 20))!;
    // baseline at page-unit y = 400 - 300 = 100; ascent 8, descent 2
    close(t.rect.x, 100);
    close(t.rect.width, 20);
    close(t.rect.y, 92);
    close(t.rect.height, 10);
  });

  it('rotation 90: page is turned clockwise, text runs downwards', () => {
    const vt = viewportTransform(view, 90);
    const t = toTextItem(vt, run('W1', 100, 300, 10, 20))!;
    // (x, y) user → (y, x) page units for this view box; text advance goes +y, "up" goes +x
    close(t.rect.x, 300 - 2);
    close(t.rect.width, 10);
    close(t.rect.y, 100);
    close(t.rect.height, 20);
  });

  it('rotation 180 / 270 keep the box inside the rotated page', () => {
    for (const r of [180, 270]) {
      const vt = viewportTransform(view, r);
      const t = toTextItem(vt, run('AB', 100, 300, 10, 20))!;
      const pw = r === 270 ? 400 : 600;
      const ph = r === 270 ? 600 : 400;
      expect(t.rect.x).toBeGreaterThanOrEqual(0);
      expect(t.rect.y).toBeGreaterThanOrEqual(0);
      expect(t.rect.x + t.rect.width).toBeLessThanOrEqual(pw);
      expect(t.rect.y + t.rect.height).toBeLessThanOrEqual(ph);
      close(t.rect.width * t.rect.height, 200);
    }
  });

  it('text rotated inside the page (vertical label) and substring boxes', () => {
    const vt = viewportTransform(view, 0);
    // 90° CCW text: transform [0, fs, -fs, 0, x, y]
    const t = toTextItem(vt, { str: 'ABCD', transform: [0, 10, -10, 0, 50, 100], width: 40, height: 10 })!;
    close(t.rect.height, 40); // runs upwards on the page
    close(t.rect.y, 400 - 140);
    const sub = substringRect(t, 2, 4); // "CD" = upper half
    close(sub.height, 20);
    close(sub.y, 400 - 140);
  });

  it('skips empty / whitespace / marked-content items', () => {
    const vt = viewportTransform(view, 0);
    expect(toTextItems(vt, [run('', 0, 0, 10, 0), run('  ', 0, 0, 10, 5), { type: 'beginMarkedContent' }, run('X', 1, 1, 10, 6)]).map((i) => i.str)).toEqual(['X']);
  });

  it('quadRect of the whole run equals rect', () => {
    const t = toTextItem(viewportTransform(view, 90), run('hello', 10, 20, 12, 30))!;
    expect(quadRect(t.q, 0, 1)).toEqual(t.rect);
  });
});

describe('real pdf.js text (demo-facade.pdf)', () => {
  it('W1 tag bbox: rotation 0 vs 90 agree after rotating', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(readFileSync(new URL('../../public/demo-facade.pdf', import.meta.url)));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    const v0 = page.getViewport({ scale: 1 });
    const v90 = page.getViewport({ scale: 1, rotation: 90 });
    const a = toTextItems(v0.transform, tc.items).filter((i) => i.str === 'W1');
    const b = toTextItems(v90.transform, tc.items).filter((i) => i.str === 'W1');
    expect(a.length).toBe(2);
    for (let k = 0; k < a.length; k++) {
      // rotating the page 90° clockwise maps page point (x, y) → (H - y, x)
      close(b[k].rect.x, v0.height - (a[k].rect.y + a[k].rect.height), 1e-3);
      close(b[k].rect.y, a[k].rect.x, 1e-3);
      close(b[k].rect.width, a[k].rect.height, 1e-3);
    }
    const scales = detectScales(toTextItems(v0.transform, tc.items), { width: v0.width, height: v0.height });
    expect(scales.map((s) => s.denominator)).toEqual([100]);
    expect(scales[0].count).toBe(3);
    await doc.destroy();
  });
});

describe('scale notation parsing', () => {
  const dens = (s: string) => parseScaleNotations(s).map((n) => n.denominator);
  it('common notations', () => {
    expect(dens('SCALE 1:100')).toEqual([100]);
    expect(dens('1 : 50')).toEqual([50]);
    expect(dens('Scale: 1:20')).toEqual([20]);
    expect(dens('קנ״מ 1:50')).toEqual([50]);
    expect(dens('קנ"מ 1:250')).toEqual([250]);
    expect(dens('קנה מידה 1:75')).toEqual([75]);
    expect(dens('M 1:200')).toEqual([200]);
    expect(dens('M1:200')).toEqual([200]);
    expect(dens('details 1:20, elevation 1:100')).toEqual([20, 100]);
    expect(dens('1：100')).toEqual([100]);
  });
  it('prefix flag and @paper', () => {
    expect(parseScaleNotations('SCALE 1:100')[0].prefixed).toBe(true);
    expect(parseScaleNotations('1:100')[0].prefixed).toBe(false);
    expect(parseScaleNotations('1:100 @ A1')[0].paper).toBe('A1');
    expect(parseScaleNotations('1:50@A3')[0].paper).toBe('A3');
  });
  it('rejects non-scales', () => {
    expect(dens('10:30')).toEqual([]); // time
    expect(dens('11:100')).toEqual([]);
    expect(dens('1:100:5')).toEqual([]);
    expect(dens('slope 1:2')).toEqual([]); // uncommon bare ratio
    expect(dens('1:37')).toEqual([]);
    expect(dens('SCALE 1:37')).toEqual([37]); // explicit prefix accepts any N
    expect(dens('2.1:100')).toEqual([]);
  });
  it('ratio index points at "1:N"', () => {
    const [n] = parseScaleNotations('SCALE 1:100');
    expect('SCALE 1:100'.slice(n.ratioIndex, n.ratioIndex + n.ratioLength)).toBe('1:100');
  });
});

describe('scale → calibration', () => {
  it('pixelsPerMeter = (72/0.0254)/N', () => {
    close(POINTS_PER_METER, 2834.645669, 1e-5);
    close(ppmForScale(100), 28.34645669, 1e-7);
    close(ppmForScale(50), 56.69291339, 1e-7);
  });
  const vt = viewportTransform([0, 0, 1683.78, 1190.55], 0);
  const items: TextItem[] = toTextItems(vt, [
    run('SOUTH ELEVATION', 600, 840, 12, 100),
    run('SCALE 1:100', 600, 820, 10, 64),
    run('DETAIL A — SCALE 1:20', 100, 300, 8, 90),
    run('SCALE', 1145, 70, 6.5, 21),
    run('1:100', 1145, 60, 11, 35),
  ]);
  it('groups by scale, most frequent first; separate "SCALE" label counts as prefix', () => {
    const d = detectScales(items, { width: 1683.78, height: 1190.55 });
    expect(d.map((x) => [x.denominator, x.count, x.prefixed])).toEqual([
      [100, 2, true],
      [20, 1, true],
    ]);
  });
  it('synthetic 1 m reference measures exactly 1 m', () => {
    const [d] = detectScales(items, { width: 1683.78, height: 1190.55 });
    const c = calibrationFromScale(d, { width: 1683.78, height: 1190.55 });
    expect(c.auto).toBe(true);
    expect(c.source).toBe('1:100');
    close(c.pixelsPerMeter, 28.3464567, 1e-6);
    close(lengthMeters(c.p1, c.p2, c.pixelsPerMeter), 1);
    // 10 m at 1:100 = 283.46 pt
    close(lengthMeters({ x: 0, y: 0 }, { x: 283.4645669, y: 0 }, c.pixelsPerMeter), 10, 1e-6);
  });
  it('"1:100 @A1" on an A3 page is rescaled', () => {
    const a3 = { width: 1190.55, height: 841.89 };
    const it3 = toTextItems(viewportTransform([0, 0, a3.width, a3.height], 0), [run('SCALE 1:100 @A1', 100, 100, 8, 60)]);
    const [d] = detectScales(it3, a3);
    close(d.paperFactor!, 420 / 841);
    close(d.pixelsPerMeter, ppmForScale(100) * (420 / 841));
  });
});

describe('paper size', () => {
  it('A0–A4 both orientations', () => {
    expect(detectPaperSize({ width: 1683.78, height: 1190.55 })).toMatchObject({ name: 'A2', orientation: 'landscape' });
    expect(detectPaperSize({ width: 2383.94, height: 1683.78 })).toMatchObject({ name: 'A1', orientation: 'landscape' });
    expect(detectPaperSize({ width: 595.28, height: 841.89 })).toMatchObject({ name: 'A4', orientation: 'portrait' });
    expect(detectPaperSize({ width: 3370.39, height: 2383.94 })?.name).toBe('A0');
    expect(detectPaperSize({ width: 841.89, height: 1190.55 })?.name).toBe('A3');
    expect(detectPaperSize({ width: 612, height: 792 })).toBeNull(); // US Letter
    expect(formatPaper({ width: 1683.78, height: 1190.55 })).toBe('A2 לרוחב · 594×420 מ״מ');
  });
});

describe('search', () => {
  const vt = viewportTransform([0, 0, 600, 400], 0);
  const items = toTextItems(vt, [
    run('W1', 10, 10, 10, 12),
    run('W1 Aluminium window', 10, 50, 10, 100),
    run('W10', 10, 90, 10, 18),
    run('w1', 10, 130, 10, 12),
    run('CW-1', 10, 170, 10, 24),
  ]);
  it('whole word, case-insensitive by default', () => {
    const re = buildMatcher('W1', DEFAULT_SEARCH_OPTIONS)!;
    const m = findInItems(items, 3, re);
    expect(m.map((x) => x.context)).toEqual(['W1', 'W1 Aluminium window', 'w1']);
    expect(m[1].rect.width).toBeCloseTo((100 * 2) / 19, 6); // proportional sub-box
    expect(m[0].page).toBe(3);
  });
  it('case sensitive / substring / regex', () => {
    expect(findInItems(items, 1, buildMatcher('W1', { ...DEFAULT_SEARCH_OPTIONS, caseSensitive: true })!)).toHaveLength(2);
    expect(findInItems(items, 1, buildMatcher('W1', { ...DEFAULT_SEARCH_OPTIONS, wholeWord: false })!)).toHaveLength(4);
    expect(findInItems(items, 1, buildMatcher('^C?W-?1$', { wholeWord: false, caseSensitive: true, regex: true })!)).toHaveLength(2);
    expect(() => buildMatcher('(', { ...DEFAULT_SEARCH_OPTIONS, regex: true })).toThrow(/רגולרי/);
    expect(buildMatcher('  ', DEFAULT_SEARCH_OPTIONS)).toBeNull();
  });
  it('Hebrew whole word', () => {
    const he = toTextItems(vt, [run('חלון ח-1', 0, 0, 10, 40), run('חלונות', 0, 20, 10, 30)]);
    expect(findInItems(he, 1, buildMatcher('חלון', DEFAULT_SEARCH_OPTIONS)!)).toHaveLength(1);
  });
  it('detects tags with counts', () => {
    const tags = detectTags([...items, ...toTextItems(vt, [run('D2, D2 (A-301) A2 RAL', 0, 0, 10, 10)])]);
    expect(tags).toEqual([
      { tag: 'D2', count: 2 },
      { tag: 'W1', count: 2 },
      { tag: 'A-301', count: 1 },
      { tag: 'CW-1', count: 1 },
      { tag: 'W10', count: 1 },
    ]);
  });
});

describe('result context', () => {
  it('adds the following run on the same line (legend tag + description)', () => {
    const vt = viewportTransform([0, 0, 600, 400], 0);
    const items = toTextItems(vt, [run('W1', 10, 300, 8, 10), run('Aluminium window', 24, 300, 8, 60), run('D1', 10, 290, 8, 10)]);
    const m = findInItems(items, 1, buildMatcher('W1', DEFAULT_SEARCH_OPTIONS)!);
    expect(m[0].after).toBe('Aluminium window');
    expect(findInItems(items, 1, buildMatcher('D1', DEFAULT_SEARCH_OPTIONS)!)[0].after).toBeUndefined();
  });
});

import { substringRect as subRect, startsRtl } from './textGeometry';
describe('RTL text highlight position', () => {
  // "חזית צפונית" drawn left→right on screen from x=100 to x=210 (11 chars, 10 units each)
  const item = { str: 'חזית צפונית', q: [100, 50, 110, 0, 0, -12] as [number, number, number, number, number, number], rect: { x: 100, y: 38, width: 110, height: 12 }, rtl: true };
  it('maps logical indices from the right end for Hebrew runs', () => {
    const r = subRect(item, 5, 11); // "צפונית" = the visually LEFT word
    expect(r.x).toBeCloseTo(100, 6);
    expect(r.width).toBeCloseTo(60, 6);
    const r2 = subRect(item, 0, 4); // "חזית" = the visually RIGHT word
    expect(r2.x + r2.width).toBeCloseTo(210, 6);
  });
  it('detects RTL from the first strong character', () => {
    expect(startsRtl('חזית צפונית')).toBe(true);
    expect(startsRtl('12 W1 חלון')).toBe(false);
    expect(startsRtl('1:100 קנ״מ')).toBe(true);
  });
});
