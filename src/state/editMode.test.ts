import { beforeEach, describe, expect, it } from 'vitest';
import { addedDocIds, CLEAN_TOOLS, docIdAtPage, isCleanTool, itemsTableAvailable, modeReducer, toolShortcutAllowed } from './editMode';
import { TOOLS, toolForKey } from '../components/toolActions';
import { hasTempMeasurements, isTempMeasurement, persistentMeasurements } from '../core/tempMeasurements';
import { useViewer } from './store';
import { useUi } from './uiStore';
import type { AreaMeasurement, ToolId } from '../core/types';

describe('modeReducer', () => {
  it('"מצב עריכה" enters edit mode, keeps the tool and drops the quick checks', () => {
    expect(modeReducer(false, { type: 'enterEdit', tool: 'rectArea' })).toEqual({ editMode: true, discardTemp: true });
  });
  it('there is no way back from edit mode except opening a file', () => {
    expect(modeReducer(true, { type: 'enterEdit', tool: 'note' })).toEqual({ editMode: true });
    for (const t of ['pan', 'note', 'count', 'calibrate'] as ToolId[]) {
      expect(modeReducer(true, { type: 'toolChanged', tool: t })).toEqual({ editMode: true });
    }
  });
  it('a tool outside the clean dock never switches the view mode to edit mode (it is refused → hand)', () => {
    for (const t of ['note', 'text', 'rect', 'count', 'pen', 'link'] as ToolId[]) {
      expect(modeReducer(false, { type: 'toolChanged', tool: t })).toEqual({ editMode: false, tool: 'pan' });
    }
  });
  it('clean tools never change the mode', () => {
    for (const t of CLEAN_TOOLS) {
      expect(modeReducer(false, { type: 'toolChanged', tool: t })).toEqual({ editMode: false });
      expect(modeReducer(true, { type: 'toolChanged', tool: t })).toEqual({ editMode: true });
    }
  });
  it('opening a file always returns to the clean mode and drops the quick checks', () => {
    expect(modeReducer(true, { type: 'fileOpened', tool: 'arrow' })).toEqual({ editMode: false, tool: 'pan', discardTemp: true });
    expect(modeReducer(true, { type: 'fileOpened', tool: 'deduct' })).toEqual({ editMode: false, discardTemp: true });
    expect(modeReducer(false, { type: 'fileOpened', tool: 'pan' })).toEqual({ editMode: false, discardTemp: true });
  });
  it('the items table exists in edit mode only', () => {
    expect(itemsTableAvailable({ editMode: false })).toBe(false);
    expect(itemsTableAvailable({ editMode: true })).toBe(true);
  });
});

describe('shortcut → mode', () => {
  it('every clean tool exists in TOOLS and the area menu is fully in the clean dock', () => {
    for (const t of CLEAN_TOOLS) expect(TOOLS.some((x) => x.id === t)).toBe(true);
    for (const t of TOOLS.filter((x) => x.menu === 'area')) expect(isCleanTool(t.id)).toBe(true);
  });
  it('view mode: dock keys work, markup keys do nothing; edit mode: every key works', () => {
    const allowed = (code: string, edit: boolean) => {
      const t = toolForKey(code);
      return t ? toolShortcutAllowed(edit, t) : null;
    };
    for (const k of ['KeyV', 'KeyH', 'KeyC', 'KeyA', 'KeyB', 'KeyD', 'KeyO', 'KeyL']) expect(allowed(k, false)).toBe(true);
    for (const k of ['KeyN', 'KeyK', 'KeyX', 'KeyR', 'KeyI', 'KeyJ', 'KeyY', 'KeyZ', 'KeyU', 'KeyW', 'KeyP', 'KeyG']) {
      expect(allowed(k, false)).toBe(false);
      expect(allowed(k, true)).toBe(true);
    }
  });
  it('Q is not a mode key (nor a tool)', () => {
    expect(toolForKey('KeyQ')).toBeUndefined();
  });
});

describe('addedDocIds / docIdAtPage', () => {
  it('reports only new ids', () => {
    expect(addedDocIds(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
    expect(addedDocIds(['a', 'b'], ['b'])).toEqual([]);
    expect(addedDocIds([], ['x'])).toEqual(['x']);
  });
  it('maps a global page to its file', () => {
    const docs = [
      { id: 'a', pageOffset: 0, numPages: 2 },
      { id: 'b', pageOffset: 2, numPages: 3 },
    ];
    expect(docIdAtPage(docs, 1)).toBe('a');
    expect(docIdAtPage(docs, 2)).toBe('a');
    expect(docIdAtPage(docs, 3)).toBe('b');
    expect(docIdAtPage(docs, 6)).toBeNull();
  });
});

const meas = (id: string, temp?: boolean): AreaMeasurement => ({
  id,
  page: 1,
  label: id,
  kind: 'area',
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
  ],
  color: '#000',
  ...(temp ? { temp: true } : {}),
});

describe('temporary (view-mode) measurements', () => {
  it('persistentMeasurements drops temp ones and keeps identity when there are none', () => {
    const plain = [meas('a'), meas('b')];
    expect(persistentMeasurements(plain)).toBe(plain);
    const mixed = [meas('a'), meas('t', true), meas('b')];
    const kept = persistentMeasurements(mixed);
    expect(kept.map((m) => m.id)).toEqual(['a', 'b']);
    expect(persistentMeasurements(mixed)).toBe(kept); // cached → stable for selectors
    expect(hasTempMeasurements(mixed)).toBe(true);
    expect(isTempMeasurement(mixed[1])).toBe(true);
  });

  beforeEach(() => {
    useUi.setState({ editMode: false });
    useViewer.getState().setDocument({ fileName: 'x.pdf', numPages: 1, pageSizes: [{ width: 100, height: 100 }] });
  });

  it('store: view-mode measurements are temp, edit-mode ones are not; discard drops only temp + clears undo', () => {
    const v = useViewer.getState();
    v.addMeasurement(meas('t1'));
    expect(useViewer.getState().measurements[0].temp).toBe(true);
    v.setCalibration(1, { pixelsPerMeter: 10 } as never);
    useUi.setState({ editMode: true });
    v.addMeasurement(meas('e1'));
    expect(useViewer.getState().measurements[1].temp).toBeUndefined();
    v.discardTempMeasurements();
    const s = useViewer.getState();
    expect(s.measurements.map((m) => m.id)).toEqual(['e1']);
    expect(s.calibrations[1]).toBeDefined(); // calibrations survive
    expect(s.historyPast).toEqual([]);
  });

  it('store: setTool refuses non-clean tools in the view mode', () => {
    const v = useViewer.getState();
    v.setTool('count');
    expect(useViewer.getState().tool).toBe('pan');
    v.setTool('length');
    expect(useViewer.getState().tool).toBe('length');
    useUi.setState({ editMode: true });
    v.setTool('count');
    expect(useViewer.getState().tool).toBe('count');
  });
});
