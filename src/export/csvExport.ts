/**
 * CSV export with page / kind / category filters and section choice. Reuses
 * `buildMeasurementRows` (same columns, Hebrew headers, UTF-8 BOM for Excel).
 */
import type { AreaMeasurement, Calibration, Category } from '../core/types';
import {
  assignDeductions,
  buildMeasurementRows,
  categoryKey,
  computeCategorySummaries,
  isMarkupKind,
  kindOf,
  takeoffOnly,
} from '../core/measurementEngine';
import type { CsvOptions } from './types';

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The measurements a CSV export covers (pages ∩ kinds ∩ categories; notes/text kept for the notes section). */
export function selectCsvMeasurements(
  measurements: AreaMeasurement[],
  pages: Iterable<number>,
  o: Pick<CsvOptions, 'kinds' | 'categories' | 'notes'>,
): AreaMeasurement[] {
  const pageSet = new Set(pages);
  const onPages = measurements.filter((m) => pageSet.has(m.page));
  const cats = o.categories ? new Set(o.categories) : null;
  // A deduction (usually uncategorised) follows the category of the area it sits in.
  const parent = assignDeductions(takeoffOnly(onPages));
  const byId = new Map(onPages.map((m) => [m.id, m]));
  const catOk = (m: AreaMeasurement) => {
    if (!cats) return true;
    if (cats.has(categoryKey(m))) return true;
    const p = kindOf(m) === 'deduct' ? parent.get(m.id) : null;
    return !!p && cats.has(categoryKey(byId.get(p) ?? {}));
  };
  return onPages.filter((m) => {
    if (isMarkupKind(m.kind)) return o.notes && (m.kind === 'note' || m.kind === 'text');
    return (o.kinds as string[]).includes(kindOf(m)) && catOk(m);
  });
}

export function buildExportCsv(
  measurements: AreaMeasurement[],
  calibrations: Record<number, Calibration>,
  categories: Category[],
  pages: Iterable<number>,
  o: CsvOptions,
): string {
  const set = selectCsvMeasurements(measurements, pages, o);
  const rows = buildMeasurementRows(set, calibrations, categories);
  // Section boundaries, mirroring buildMeasurementRows' layout:
  // header | one row per takeoff measurement | category subtotals | 5 totals rows | notes section.
  const takeoff = takeoffOnly(set);
  const nRows = takeoff.length;
  const nCats = takeoff.some((m) => categoryKey(m)) ? computeCategorySummaries(takeoff, calibrations, categories).length : 0;
  const header = rows.slice(0, 1);
  const body = rows.slice(1, 1 + nRows);
  const catRows = rows.slice(1 + nRows, 1 + nRows + nCats);
  const totals = rows.slice(1 + nRows + nCats, 1 + nRows + nCats + 5);
  const notes = rows.slice(1 + nRows + nCats + 5);
  const out = [
    ...header,
    ...(o.rows ? body : []),
    ...(o.categoryTotals ? catRows : []),
    ...(o.totals ? totals : []),
    ...(o.notes ? notes : []),
  ];
  return '﻿' + out.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
