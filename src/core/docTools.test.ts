import { describe, expect, it } from 'vitest';
import type { TextItem } from './types';
import {
  TEXT_EDIT_PAD,
  boxFontSize,
  defaultSignatureSize,
  estimateTextWidth,
  findTextRunAt,
  formatSignatureDate,
  isEditableRun,
  resizeLocked,
  runCoverRect,
  signatureBounds,
  signatureBoxAt,
  textEditBaseline,
  textEditCoverRect,
  textEditFromRun,
} from './docTools';
import { hitMarkup, markupBounds } from './markupGeometry';
import { isMarkupKind, takeoffOnly } from './measurementEngine';
import { toTextItem, viewportTransform } from '../text/textGeometry';
import { dataUrlByteSize, decodeDataUrl, fitScale, inkBounds, removeWhiteBackground, smoothStroke, type Pixels } from './signatureImage';

/** Horizontal run: bottom-left (x, yBottom), width w, font height h. */
const run = (str: string, x: number, yBottom: number, w: number, h: number, rtl = false): TextItem => ({
  str,
  q: [x, yBottom, w, 0, 0, -h],
  rect: { x, y: yBottom - h, width: w, height: h },
  ...(rtl ? { rtl } : {}),
});

describe('text run lookup', () => {
  const items = [
    run('SOUTH ELEVATION', 100, 200, 150, 12),
    run('SOUTH', 100, 200, 50, 12),
    run('חזית דרומית', 300, 200, 90, 10, true),
    // rotated (vertical) dimension text: not editable
    { str: '1200', q: [500, 300, 0, -40, -10, 0], rect: { x: 490, y: 260, width: 10, height: 40 } } as TextItem,
  ];
  it('finds the smallest run under the point', () => {
    expect(findTextRunAt(items, { x: 120, y: 195 })).toBe(1); // inside both → the word wins
    expect(findTextRunAt(items, { x: 200, y: 195 })).toBe(0);
    expect(findTextRunAt(items, { x: 340, y: 195 })).toBe(2);
    expect(findTextRunAt(items, { x: 50, y: 50 })).toBe(-1);
  });
  it('slop widens the hit; vertical runs are skipped', () => {
    expect(findTextRunAt(items, { x: 120, y: 203 })).toBe(-1);
    expect(findTextRunAt(items, { x: 120, y: 203 }, 4)).toBe(1);
    expect(isEditableRun(items[3])).toBe(false);
    expect(findTextRunAt(items, { x: 495, y: 280 })).toBe(-1);
  });
  it('works on runs produced by textGeometry (real pdf.js-style items)', () => {
    const vt = viewportTransform([0, 0, 600, 800]);
    const it = toTextItem(vt, { str: 'שלום', transform: [10, 0, 0, 10, 100, 700], width: 30, height: 10, dir: 'rtl' })!;
    expect(isEditableRun(it)).toBe(true);
    expect(findTextRunAt([it], { x: 115, y: 95 })).toBe(0);
    const e = textEditFromRun(it);
    expect(e.rtl).toBe(true);
    expect(e.text).toBe('שלום');
    expect(e.fontSize).toBeCloseTo(10);
  });
});

describe('textEdit geometry', () => {
  const it0 = run('SOUTH', 100, 200, 50, 10);
  const m = { kind: 'textEdit', ...textEditFromRun(it0) };
  it('cover = run bounds + padding; prefilled with the original', () => {
    const c = runCoverRect(it0);
    const pad = 10 * TEXT_EDIT_PAD;
    expect(c).toEqual({ x: 100 - pad, y: 190 - pad, width: 50 + 2 * pad, height: 10 + 2 * pad });
    expect(m.text).toBe('SOUTH');
    expect(m.origText).toBe('SOUTH');
    expect(textEditCoverRect(m)).toEqual(c);
  });
  it('same-length replacement keeps the cover; longer grows towards the reading direction', () => {
    expect(estimateTextWidth(m, 'NORTH')).toBeCloseTo(50);
    const longer = { ...m, text: 'SOUTH-WEST' }; // 10 chars → 100 wide
    const c = textEditCoverRect(longer);
    expect(c.x).toBeCloseTo(m.points[0].x);
    expect(c.width).toBeCloseTo(100 + 2 * 10 * TEXT_EDIT_PAD);
    const rtl = { ...longer, rtl: true };
    const r = textEditCoverRect(rtl);
    expect(r.x + r.width).toBeCloseTo(m.points[1].x); // right edge stays
    expect(r.width).toBeCloseTo(c.width);
  });
  it('baseline: original baseline, start edge by direction', () => {
    const b = textEditBaseline(m);
    expect(b.y).toBeCloseTo(200 - 10 * 0.2); // run bottom (incl. descent) - descent
    expect(b.x).toBeCloseTo(100);
    const r = textEditBaseline({ ...m, rtl: true });
    expect(r.x).toBeCloseTo(150);
  });
  it('box mode (scan): font from the box height, text centred vertically', () => {
    expect(boxFontSize({ x: 0, y: 0, width: 100, height: 20 })).toBe(12);
    const box = { points: [{ x: 0, y: 0 }, { x: 100, y: 40 }], fontSize: 10, text: 'x' };
    const b = textEditBaseline(box);
    // glyph box (ascent 0.8, descent 0.2) is centred within the 40-unit box
    expect(b.y - 8 - 0).toBeCloseTo(40 - (b.y + 2));
  });
  it('hit testing and bounds (markupGeometry)', () => {
    const tm = { ...m, kind: 'textEdit' };
    expect(markupBounds(tm)).toEqual(textEditCoverRect(m));
    expect(hitMarkup({ x: 120, y: 195 }, tm, 0)).toBe(true);
    expect(hitMarkup({ x: 120, y: 230 }, tm, 0)).toBe(false);
    expect(hitMarkup({ x: 120, y: 203 }, tm, 2)).toBe(true);
    expect(hitMarkup({ x: 120, y: 203 }, tm, 10, 0.1)).toBe(false); // filled edits: ≤ 2 screen px of slop
  });
  it('document kinds are markup, never takeoff quantities', () => {
    expect(isMarkupKind('textEdit')).toBe(true);
    expect(isMarkupKind('signature')).toBe(true);
    const all = [
      { id: 'a', kind: 'area' as const },
      { id: 't', kind: 'textEdit' as const },
      { id: 's', kind: 'signature' as const },
    ];
    expect(takeoffOnly(all).map((x) => x.id)).toEqual(['a']);
  });
});

describe('signature geometry', () => {
  it('default size: ~180 screen px, clamped to 90–220 pt and half the page', () => {
    expect(defaultSignatureSize(3, 1, 2000)).toEqual({ width: 180, height: 60 });
    expect(defaultSignatureSize(3, 0.1, 2000).width).toBe(220);
    expect(defaultSignatureSize(3, 10, 2000).width).toBe(90);
    expect(defaultSignatureSize(2, 1, 100).width).toBe(50);
  });
  it('box centred on the click; bounds include the date line', () => {
    const pts = signatureBoxAt({ x: 100, y: 100 }, { width: 60, height: 20 });
    expect(pts).toEqual([{ x: 70, y: 90 }, { x: 130, y: 110 }]);
    const s = { kind: 'signature', points: pts };
    expect(signatureBounds(s)).toEqual({ x: 70, y: 90, width: 60, height: 20 });
    const d = signatureBounds({ ...s, text: '09.11.2026' });
    expect(d.height).toBeGreaterThan(20);
    expect(hitMarkup({ x: 100, y: 100 }, s, 0)).toBe(true);
    expect(hitMarkup({ x: 100, y: d.y + d.height - 0.5 }, { ...s, text: '09.11.2026' }, 0)).toBe(true);
    expect(hitMarkup({ x: 100, y: 112 }, s, 0)).toBe(false);
  });
  it('locked-aspect resize keeps the anchor and the ratio, never flips', () => {
    const a = { x: 0, y: 0 };
    const p = resizeLocked(a, { x: 30, y: 10 }, { x: 60, y: 5 }, 3);
    expect(p).toEqual({ x: 60, y: 20 });
    const q = resizeLocked(a, { x: 30, y: 10 }, { x: 10, y: 30 }, 3); // dragged mostly down
    expect(q).toEqual({ x: 90, y: 30 });
    const r = resizeLocked(a, { x: 30, y: 10 }, { x: -50, y: -50 }, 3, 6); // past the anchor → min size
    expect(r).toEqual({ x: 6, y: 2 });
    // top-left corner with the bottom-right as anchor
    const t = resizeLocked({ x: 100, y: 100 }, { x: 70, y: 90 }, { x: 40, y: 95 }, 3);
    expect(t).toEqual({ x: 40, y: 80 });
  });
  it('date format', () => {
    expect(formatSignatureDate(new Date(2026, 10, 9))).toBe('09.11.2026');
  });
});

describe('signature image (pure pixel helpers)', () => {
  /** w×h white opaque image with an opaque dark block. */
  const img = (w: number, h: number, ink: { x: number; y: number; w: number; h: number }, bg = 255): Pixels => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const on = x >= ink.x && x < ink.x + ink.w && y >= ink.y && y < ink.y + ink.h;
        data[i] = data[i + 1] = data[i + 2] = on ? 20 : bg;
        data[i + 3] = 255;
      }
    return { data, width: w, height: h };
  };
  it('trims to the ink on an opaque white image (JPG-like) and on a transparent one', () => {
    expect(inkBounds(img(40, 20, { x: 5, y: 3, w: 10, h: 4 }))).toEqual({ x: 5, y: 3, width: 10, height: 4 });
    expect(inkBounds(img(40, 20, { x: 5, y: 3, w: 10, h: 4 }), 10, 2)).toEqual({ x: 3, y: 1, width: 14, height: 8 });
    const t = img(10, 10, { x: 2, y: 2, w: 1, h: 1 });
    for (let i = 3; i < t.data.length; i += 4) if (t.data[i - 3] === 255) t.data[i] = 0;
    expect(inkBounds(t)).toEqual({ x: 2, y: 2, width: 1, height: 1 });
    expect(inkBounds(img(5, 5, { x: 0, y: 0, w: 0, h: 0 }))).toBeNull();
  });
  it('removes a (slightly off-) white background, keeps the ink', () => {
    const p = removeWhiteBackground(img(4, 1, { x: 0, y: 0, w: 1, h: 1 }, 240));
    expect(p.data[3]).toBe(255); // ink
    expect(p.data[7]).toBe(0); // paper
    const mid = removeWhiteBackground({ data: new Uint8ClampedArray([200, 200, 200, 255]), width: 1, height: 1 });
    expect(mid.data[3]).toBeGreaterThan(0);
    expect(mid.data[3]).toBeLessThan(255);
  });
  it('fit scale, data URL size / decode', () => {
    expect(fitScale(1200, 200)).toBe(0.5);
    expect(fitScale(100, 50)).toBe(1);
    const url = 'data:image/png;base64,' + btoa('abcdef');
    expect(dataUrlByteSize(url)).toBe(6);
    const d = decodeDataUrl(url)!;
    expect(d.mime).toBe('image/png');
    expect(new TextDecoder().decode(d.bytes)).toBe('abcdef');
    expect(decodeDataUrl('nope')).toBeNull();
  });
  it('smooth stroke: quadratic segments through midpoints', () => {
    const s = smoothStroke([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(s[0]).toEqual({ t: 'M', p: { x: 0, y: 0 } });
    expect(s[1]).toEqual({ t: 'Q', c: { x: 10, y: 0 }, p: { x: 10, y: 5 } });
    expect(s[2]).toEqual({ t: 'L', p: { x: 10, y: 10 } });
    expect(smoothStroke([{ x: 1, y: 1 }])).toHaveLength(2);
  });
});
