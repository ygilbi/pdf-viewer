import { describe, expect, it } from 'vitest';
import type { AreaMeasurement, Calibration, WorkspaceDoc } from '../core/types';
import { globalPageOf, locatePage, withOffsets } from '../core/workspaceMap';
import { concatPages, docAtPage, extractDocData, removeDocFromWorkspace, toGlobalData } from './workspace';

const size = { width: 100, height: 200 };
function doc(id: string, numPages: number): WorkspaceDoc {
  return { id, name: `${id}.pdf`, numPages, pageOffset: 0, pageSizes: Array.from({ length: numPages }, () => size) };
}
const cal = (m: number): Calibration => ({ pixelsPerMeter: m, p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 }, meters: 1 });
const meas = (id: string, page: number): AreaMeasurement => ({ id, page, label: id, points: [{ x: 0, y: 0 }], color: '#000000' });

// A: 3 pages (1-3), B: 40 pages (4-43), C: 2 pages (44-45)
const docs = withOffsets([doc('A', 3), doc('B', 40), doc('C', 2)]);

describe('global <-> local page mapping', () => {
  it('lays out offsets in order', () => {
    expect(docs.map((d) => d.pageOffset)).toEqual([0, 3, 43]);
    expect(concatPages(docs).numPages).toBe(45);
    expect(concatPages(docs).pageSizes).toHaveLength(45);
  });
  it('locates global pages', () => {
    expect(locatePage(docs, 1)).toEqual({ docId: 'A', localPage: 1 });
    expect(locatePage(docs, 3)).toEqual({ docId: 'A', localPage: 3 });
    expect(locatePage(docs, 4)).toEqual({ docId: 'B', localPage: 1 });
    expect(locatePage(docs, 43)).toEqual({ docId: 'B', localPage: 40 });
    expect(locatePage(docs, 44)).toEqual({ docId: 'C', localPage: 1 });
    expect(locatePage(docs, 0)).toBeNull();
    expect(locatePage(docs, 46)).toBeNull();
    expect(locatePage([], 1)).toBeNull();
    expect(docAtPage(docs, 5)?.id).toBe('B');
  });
  it('maps local back to global', () => {
    expect(globalPageOf(docs, 'B', 2)).toBe(5);
    expect(globalPageOf(docs, 'C', 2)).toBe(45);
    expect(globalPageOf(docs, 'C', 3)).toBeNull();
    expect(globalPageOf(docs, 'X', 1)).toBeNull();
  });
  it('round-trips persisted (local) data', () => {
    const ms = [meas('a1', 2), meas('b1', 5), meas('c1', 45)];
    const cals = { 2: cal(1), 5: cal(2), 44: cal(3) };
    const b = extractDocData(docs[1], ms, cals);
    expect(b.measurements.map((m) => [m.id, m.page])).toEqual([['b1', 2]]);
    expect(Object.keys(b.calibrations)).toEqual(['2']);
    const back = toGlobalData(docs[1], b.measurements, b.calibrations);
    expect(back.measurements[0].page).toBe(5);
    expect(back.calibrations[5]).toEqual(cal(2));
    // out-of-range saved pages are dropped
    expect(toGlobalData(docs[2], [meas('x', 3)], { 9: cal(1) })).toEqual({ measurements: [], calibrations: {} });
  });
});

describe('removeDocFromWorkspace', () => {
  const measurements = [meas('a1', 2), meas('b1', 5), meas('c1', 45)];
  const calibrations = { 1: cal(1), 5: cal(2), 44: cal(3) };

  it('drops the doc data and renumbers later docs', () => {
    const r = removeDocFromWorkspace({ docs, measurements, calibrations, currentPage: 5 }, 'A')!;
    expect(r.docs.map((d) => [d.id, d.pageOffset])).toEqual([['B', 0], ['C', 40]]);
    expect(r.numPages).toBe(42);
    expect(r.measurements.map((m) => [m.id, m.page])).toEqual([['b1', 2], ['c1', 42]]);
    expect(Object.keys(r.calibrations).map(Number).sort((x, y) => x - y)).toEqual([2, 41]);
    expect(r.currentPage).toBe(2);
  });
  it('removing a middle doc keeps earlier pages and moves currentPage', () => {
    const r = removeDocFromWorkspace({ docs, measurements, calibrations, currentPage: 10 }, 'B')!;
    expect(r.measurements.map((m) => [m.id, m.page])).toEqual([['a1', 2], ['c1', 5]]);
    expect(r.calibrations[1]).toEqual(cal(1));
    expect(r.calibrations[4]).toEqual(cal(3));
    expect(r.currentPage).toBe(4); // first page of the file that took its place
  });
  it('clamps currentPage when the last doc is removed, empties on last file', () => {
    const r = removeDocFromWorkspace({ docs, measurements, calibrations, currentPage: 45 }, 'C')!;
    expect(r.currentPage).toBe(43);
    const one = withOffsets([doc('A', 3)]);
    const e = removeDocFromWorkspace({ docs: one, measurements: [meas('a', 1)], calibrations: { 1: cal(1) }, currentPage: 2 }, 'A')!;
    expect(e).toMatchObject({ docs: [], numPages: 0, measurements: [], calibrations: {}, currentPage: 1 });
    expect(removeDocFromWorkspace({ docs, measurements, calibrations, currentPage: 1 }, 'nope')).toBeNull();
  });
});

describe('store workspace actions', async () => {
  const { useViewer } = await import('./store');
  it('addDocument concatenates, removeDocument renumbers', () => {
    const s = useViewer.getState();
    s.setDocument({ fileName: 'A.pdf', numPages: 3, pageSizes: doc('A', 3).pageSizes, docId: 'A' });
    useViewer.getState().addDocument({ ...doc('B', 40), pageOffset: 999 });
    let st = useViewer.getState();
    expect(st.numPages).toBe(43);
    expect(st.pageSizes).toHaveLength(43);
    expect(st.docs.map((d) => d.pageOffset)).toEqual([0, 3]);
    st.addMeasurement(meas('b', 5));
    st.addMeasurement(meas('a', 1));
    st.setCalibration(5, cal(7));
    st.setPage(5);
    useViewer.getState().removeDocument('A');
    st = useViewer.getState();
    expect(st.fileName).toBe('B.pdf');
    expect(st.numPages).toBe(40);
    expect(st.measurements.map((m) => [m.id, m.page])).toEqual([['b', 2]]);
    expect(st.calibrations).toEqual({ 2: cal(7) });
    expect(st.currentPage).toBe(2);
    useViewer.getState().removeDocument('B');
    expect(useViewer.getState()).toMatchObject({ numPages: 0, docs: [], fileName: null });
  });
});
