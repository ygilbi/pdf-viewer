import { describe, expect, it } from 'vitest';
import { computeHint, UNCALIBRATED_TITLE, type HintInput } from './hints';

const base: HintInput = {
  tool: 'pan',
  draftLength: 0,
  calibrated: true,
  touch: false,
  snapEnabled: true,
  countMeasuringLabel: null,
  activeCountLabel: null,
  selectedLabel: null,
  editingKind: null,
  searchOpen: false,
};
const h = (p: Partial<HintInput>) => computeHint({ ...base, ...p })!;
const all = (p: Partial<HintInput>) => {
  const x = h(p);
  return [x.title, ...x.lines].join('\n');
};

describe('computeHint', () => {
  it('pan: desktop wheel/zoom keys vs touch gestures', () => {
    expect(h({}).title).toContain('Ctrl+גלגלת = זום');
    expect(h({ touch: true }).title).toBe('אצבע אחת להזזה · שתיים לזום');
  });

  it('pan with a selection describes the selected item', () => {
    expect(h({ selectedLabel: 'שטח 2' }).title).toBe('נבחר: שטח 2');
    expect(all({ selectedLabel: 'שטח 2' })).toContain('Delete');
    expect(all({ selectedLabel: 'שטח 2', touch: true })).not.toContain('Delete');
  });

  it('area: corner steps with Enter / Backspace / Esc', () => {
    expect(h({ tool: 'area' }).title).toContain('סמן את פינות השטח');
    expect(h({ tool: 'area' }).lines[0]).toBe('Enter לסגירה · Backspace נקודה אחורה · Esc יציאה');
    expect(h({ tool: 'area', draftLength: 3 }).title).toContain('לסגירה');
    expect(h({ tool: 'deduct' }).title).toContain('פינות הפתח');
  });

  it('touch wording never mentions keyboard keys', () => {
    for (const tool of ['area', 'deduct', 'rectArea', 'length', 'calibrate', 'count', 'pen', 'line', 'note', 'link', 'pan'] as const) {
      for (const draftLength of [0, 1, 3]) {
        const t = all({ tool, draftLength, touch: true });
        expect(t, `${tool}/${draftLength}`).not.toMatch(/Enter|Esc|Backspace|Shift|Ctrl|Delete|לחץ /);
      }
    }
  });

  it('measuring tools on an uncalibrated page warn first', () => {
    for (const tool of ['area', 'rectArea', 'deduct', 'rectDeduct', 'length'] as const) {
      const x = h({ tool, calibrated: false });
      expect(x.title).toBe(UNCALIBRATED_TITLE);
      expect(x.warn).toBe(true);
    }
    expect(h({ tool: 'rect', calibrated: false }).warn).toBeUndefined();
  });

  it('calibrate: two points, then the known length', () => {
    expect(h({ tool: 'calibrate' }).title).toContain('1/2');
    expect(h({ tool: 'calibrate', draftLength: 1 }).title).toContain('2/2');
    expect(h({ tool: 'calibrate', draftLength: 2 }).title).toContain('הזן אורך ידוע');
  });

  it('count flow: first item → measure (with skip) → mark more', () => {
    expect(h({ tool: 'count' }).title).toBe('לחץ על הפריט הראשון שברצונך לספור');
    const m = h({ tool: 'count', countMeasuringLabel: 'פריט 1', activeCountLabel: 'פריט 1' });
    expect(m.title).toBe('מדוד את פריט 1: לחץ על שתי פינות נגדיות (או גרור)');
    expect(m.action).toBe('countSkip');
    expect(h({ tool: 'count', countMeasuringLabel: 'פריט 1', draftLength: 1 }).title).toContain('הפינה הנגדית');
    const g = h({ tool: 'count', activeCountLabel: 'פריט 1' });
    expect(g.title).toBe('סמן עוד פריטים מסוג פריט 1');
    expect(g.lines[0]).toContain('Enter / סיום לפריט הבא');
    expect(h({ tool: 'count', calibrated: false }).lines[0]).toContain('לא מכויל');
  });

  it('snap state shows on snapping tools only', () => {
    expect(all({ tool: 'length' })).toContain('הצמדה פעילה');
    expect(all({ tool: 'length', snapEnabled: false })).toContain('S להפעלה');
    expect(all({ tool: 'rect' })).not.toContain('הצמדה');
  });

  it('markup tools', () => {
    expect(h({ tool: 'pen' }).lines[0]).toContain('Shift');
    expect(h({ tool: 'pen', touch: true }).lines[0]).toContain('החזק במקום');
    expect(h({ tool: 'line' }).lines[0]).toContain('30°');
    expect(h({ tool: 'ellipse' }).title).toBe('גרור לציור אליפסה');
    expect(h({ tool: 'link' }).title).toContain('עמוד יעד');
    expect(h({ tool: 'note' }).title).toContain('הערה');
  });

  it('editing and search take precedence', () => {
    expect(h({ tool: 'note', editingKind: 'note' }).title).toBe('הקלד את תוכן ההערה');
    expect(h({ tool: 'link', editingKind: 'link' }).title).toContain('עמוד היעד');
    expect(h({ searchOpen: true }).title).toContain('חיפוש');
    // A drawing tool keeps its own prompt while the search panel is open.
    expect(h({ tool: 'area', searchOpen: true }).title).toContain('פינות');
  });
});
