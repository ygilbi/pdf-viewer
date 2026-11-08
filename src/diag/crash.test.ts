import { describe, expect, it } from 'vitest';
import { CRASH_WINDOW_MS, DEAD_AFTER_MS, classifyMarker, isBenignError, isMarker, type AliveMarker } from './crash';

const NOW = 1_800_000_000_000;
const marker = (p: Partial<AliveMarker> = {}): AliveMarker => ({ v: 1, sid: 's1', start: NOW - 60_000, hb: NOW - 1000, clean: false, errors: 0, state: {}, ...p });

describe('classifyMarker', () => {
  it('clean exit → ended (or error when uncaught errors happened)', () => {
    expect(classifyMarker(marker({ clean: true }), NOW)).toBe('ended');
    expect(classifyMarker(marker({ clean: true, errors: 2 }), NOW)).toBe('error');
  });

  it('unclean but heartbeat older than the crash window → stale', () => {
    expect(classifyMarker(marker({ hb: NOW - CRASH_WINDOW_MS - 1 }), NOW)).toBe('stale');
  });

  it('unclean and clearly dead (no heartbeat for a few seconds) → crashed at once', () => {
    expect(classifyMarker(marker({ hb: NOW - DEAD_AFTER_MS - 1 }), NOW)).toBe('crashed');
    expect(classifyMarker(marker({ hb: NOW - 90_000 }), NOW)).toBe('crashed');
  });

  it('unclean and very recent → needs a re-check (could be another open tab)', () => {
    expect(classifyMarker(marker({ hb: NOW - 500 }), NOW)).toBe('check');
  });

  it('re-check: heartbeat moved → alive; unchanged → crashed; removed/clean → ended', () => {
    const m = marker({ hb: NOW - 500 });
    expect(classifyMarker(m, NOW + 2500, { ...m, hb: NOW + 2000 })).toBe('alive');
    expect(classifyMarker(m, NOW + 2500, { ...m })).toBe('crashed');
    expect(classifyMarker(m, NOW + 2500, null)).toBe('ended');
    expect(classifyMarker(m, NOW + 2500, { ...m, clean: true })).toBe('ended');
    expect(classifyMarker(m, NOW + 2500, { ...m, clean: true, errors: 1 })).toBe('error');
  });

  it('isMarker validates the stored shape', () => {
    expect(isMarker(marker())).toBe(true);
    expect(isMarker({ sid: 'x' })).toBe(false);
    expect(isMarker(null)).toBe(false);
    expect(isMarker('x')).toBe(false);
  });

  it('benign errors do not count as crashes', () => {
    expect(isBenignError('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isBenignError('Script error.')).toBe(true);
    expect(isBenignError("TypeError: Cannot read properties of undefined (reading 'x')")).toBe(false);
  });
});
