import { beforeEach, describe, expect, it } from 'vitest';
import type { AreaMeasurement } from '../core/types';
import { useViewer } from './store';
import { COALESCE_MS, HISTORY_LIMIT, _setHistoryClock, historyGroup } from './history';

let clock = 0;
_setHistoryClock(() => clock);

const m = (id: string, x = 0): AreaMeasurement => ({
  id,
  page: 1,
  label: id,
  kind: 'area',
  points: [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }],
  color: '#000000',
});
const S = () => useViewer.getState();
const ids = () => S().measurements.map((x) => x.id);

beforeEach(() => {
  clock = 0;
  S().setDocument({ fileName: 'a.pdf', numPages: 2, pageSizes: [{ width: 100, height: 100 }, { width: 100, height: 100 }] });
});

describe('undo / redo', () => {
  it('starts empty after opening a document', () => {
    expect(S().historyPast).toHaveLength(0);
    expect(S().historyFuture).toHaveLength(0);
  });

  it('undoes and redoes add / update / remove', () => {
    S().addMeasurement(m('a'));
    S().addMeasurement(m('b'));
    S().updateMeasurement('a', { points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }] });
    S().removeMeasurement('b');
    expect(ids()).toEqual(['a']);
    S().undo();
    expect(ids()).toEqual(['a', 'b']);
    S().undo();
    expect(S().measurements[0].points[0]).toEqual({ x: 0, y: 0 });
    S().undo();
    S().undo();
    expect(ids()).toEqual([]);
    S().undo(); // no-op at the bottom
    expect(ids()).toEqual([]);
    S().redo();
    S().redo();
    S().redo();
    expect(S().measurements[0].points[0]).toEqual({ x: 1, y: 1 });
    S().redo();
    expect(ids()).toEqual(['a']);
    S().redo(); // no-op at the top
    expect(ids()).toEqual(['a']);
  });

  it('a new change clears the redo stack', () => {
    S().addMeasurement(m('a'));
    S().undo();
    expect(S().historyFuture).toHaveLength(1);
    S().addMeasurement(m('b'));
    expect(S().historyFuture).toHaveLength(0);
    expect(ids()).toEqual(['b']);
  });

  it('tracks calibrations and categories', () => {
    S().setCalibration(1, { pixelsPerMeter: 50, p1: { x: 0, y: 0 }, p2: { x: 50, y: 0 }, meters: 1 });
    const n = S().categories.length;
    S().addCategory('חדש');
    expect(S().categories).toHaveLength(n + 1);
    S().undo();
    expect(S().categories).toHaveLength(n);
    S().undo();
    expect(S().calibrations[1]).toBeUndefined();
    S().redo();
    expect(S().calibrations[1].pixelsPerMeter).toBe(50);
  });

  it('does not record selection / tool / page changes', () => {
    S().addMeasurement(m('a'));
    const before = S().historyPast.length;
    S().select(null);
    S().setTool('area');
    S().setDraft([{ x: 1, y: 1 }]);
    S().setPage(2);
    expect(S().historyPast.length).toBe(before);
  });

  it('coalesces repeated text edits of one item, never geometry edits', () => {
    S().addMeasurement({ ...m('n'), kind: 'note', text: '' });
    const base = S().historyPast.length;
    for (const t of ['a', 'ab', 'abc']) {
      clock += 100;
      S().updateMeasurement('n', { text: t });
    }
    expect(S().historyPast.length).toBe(base + 1);
    clock += COALESCE_MS + 1;
    S().updateMeasurement('n', { text: 'abcd' });
    expect(S().historyPast.length).toBe(base + 2);
    S().undo();
    expect(S().measurements[0].text).toBe('abc');
    S().undo();
    expect(S().measurements[0].text).toBe('');
    // geometry: two quick count clicks stay two steps
    S().addMeasurement({ ...m('c'), kind: 'count', points: [{ x: 0, y: 0 }] });
    const b2 = S().historyPast.length;
    S().updateMeasurement('c', { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    S().updateMeasurement('c', { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] });
    expect(S().historyPast.length).toBe(b2 + 2);
  });

  it('historyGroup makes one step', () => {
    historyGroup(() => {
      S().addMeasurement(m('a'));
      S().addMeasurement(m('b'));
      S().setCalibration(1, { pixelsPerMeter: 10, p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, meters: 1 });
    });
    expect(S().historyPast).toHaveLength(1);
    S().undo();
    expect(ids()).toEqual([]);
    expect(S().calibrations[1]).toBeUndefined();
  });

  it(`keeps at most ${HISTORY_LIMIT} steps`, () => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) S().addMeasurement(m(`m${i}`, i));
    expect(S().historyPast).toHaveLength(HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) S().undo();
    expect(S().measurements).toHaveLength(20);
  });

  it('shares structure: snapshots hold references, not copies', () => {
    S().addMeasurement(m('a'));
    const a = S().measurements[0];
    S().addMeasurement(m('b'));
    const snap = S().historyPast[S().historyPast.length - 1];
    expect(snap.measurements[0]).toBe(a);
    expect(snap.categories).toBe(S().categories);
  });

  it('clears selection of an undone measurement and the draft', () => {
    S().addMeasurement(m('a'));
    expect(S().selectedId).toBe('a');
    S().setDraft([{ x: 1, y: 1 }]);
    S().undo();
    expect(S().selectedId).toBeNull();
    expect(S().draft).toEqual([]);
  });

  it('resets on document open and file removal; external setState clears it', () => {
    S().addMeasurement(m('a'));
    S().setDocument({ fileName: 'b.pdf', numPages: 1, pageSizes: [{ width: 1, height: 1 }] });
    expect(S().historyPast).toHaveLength(0);
    S().addMeasurement(m('b'));
    useViewer.setState({ measurements: [...S().measurements, m('restored')] });
    expect(S().historyPast).toHaveLength(0);
    expect(ids()).toEqual(['b', 'restored']);
  });
});
