import { describe, expect, it } from 'vitest';
import { hitMarkup, shapeOutline, shapePath } from './markupGeometry';
import { badgeFontScale, countBadge, snapAngle } from './measurementEngine';

const R = { x: 0, y: 0, width: 100, height: 60 };

describe('shapes', () => {
  it('builds closed paths with M/L/C/Z only (pdf-lib safe)', () => {
    for (const k of ['ellipse', 'triangle', 'diamond'] as const) {
      const d = shapePath(k, R);
      expect(d.startsWith('M')).toBe(true);
      expect(d.endsWith('Z')).toBe(true);
      expect(/[^MLCZ0-9 .\-]/.test(d)).toBe(false);
    }
  });
  it('inscribes triangle / diamond in the box', () => {
    expect(shapeOutline('triangle', R)).toEqual([{ x: 50, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }]);
    expect(shapeOutline('diamond', R)).toEqual([{ x: 50, y: 0 }, { x: 100, y: 30 }, { x: 50, y: 60 }, { x: 0, y: 30 }]);
  });
  it('hits shapes on their outline only, lines along the segment', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 60 }];
    expect(hitMarkup({ x: 100, y: 30 }, { kind: 'ellipse', points: pts }, 2)).toBe(true);
    expect(hitMarkup({ x: 50, y: 30 }, { kind: 'ellipse', points: pts }, 2)).toBe(false);
    expect(hitMarkup({ x: 75, y: 15 }, { kind: 'diamond', points: pts }, 2)).toBe(true);
    expect(hitMarkup({ x: 50, y: 30 }, { kind: 'line', points: pts }, 2)).toBe(true);
    expect(hitMarkup({ x: 50, y: 0 }, { kind: 'line', points: pts }, 2)).toBe(false);
  });
  it('locks straight lines to 30° steps', () => {
    const b = snapAngle({ x: 0, y: 0 }, { x: 100, y: 52 }, 30); // ~27.5° → 30°
    expect((Math.atan2(b.y, b.x) * 180) / Math.PI).toBeCloseTo(30, 5);
  });
});

describe('count badge', () => {
  it('shows the item code, else the label number, never the quantity', () => {
    expect(countBadge({ label: 'פריט 3', item: { code: ' W1 ' } })).toBe('W1');
    expect(countBadge({ label: 'פריט 12' })).toBe('12');
    expect(countBadge({ label: 'חלון' })).toBe('חלון');
  });
  it('shrinks long badges', () => {
    expect(badgeFontScale('W1')).toBe(1);
    expect(badgeFontScale('CW-12')).toBeLessThan(0.6);
  });
});
