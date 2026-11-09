import type { AreaMeasurement } from './types';

/**
 * Temporary measurements: area / length checks made in the clean view mode (`temp: true`).
 * They live only on screen — persistence, exports (PDF / Excel / CSV / copy), the items table
 * and Save-As read the store through `persistentMeasurements()`.
 */

export const isTempMeasurement = (m: AreaMeasurement): boolean => m.temp === true;

const cache = new WeakMap<readonly AreaMeasurement[], AreaMeasurement[]>();

/**
 * The measurements that count (everything but view-mode quick checks). Returns the SAME array
 * when there is nothing to drop, and a cached filtered array per input array otherwise, so it is
 * safe inside zustand selectors / useMemo deps.
 */
export function persistentMeasurements(ms: AreaMeasurement[]): AreaMeasurement[];
export function persistentMeasurements(ms: readonly AreaMeasurement[]): readonly AreaMeasurement[];
export function persistentMeasurements(ms: readonly AreaMeasurement[]): readonly AreaMeasurement[] {
  if (!ms.some(isTempMeasurement)) return ms;
  let out = cache.get(ms);
  if (!out) {
    out = ms.filter((m) => !isTempMeasurement(m));
    cache.set(ms, out);
  }
  return out;
}

export const hasTempMeasurements = (ms: readonly AreaMeasurement[]): boolean => ms.some(isTempMeasurement);
