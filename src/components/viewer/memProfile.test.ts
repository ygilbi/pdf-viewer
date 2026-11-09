import { describe, expect, it } from 'vitest';
import { DESKTOP_PROFILE, MOBILE_PROFILE, isConstrainedDevice } from './TileLayer';

describe('raster memory profile', () => {
  it('treats iPhone / iPad / Android / low-memory / touch-first devices as constrained', () => {
    expect(isConstrainedDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)' }, false)).toBe(true);
    expect(isConstrainedDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }, false)).toBe(true);
    expect(isConstrainedDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }, false)).toBe(true);
    expect(isConstrainedDevice({ userAgent: 'X', deviceMemory: 4 }, false)).toBe(true);
    expect(isConstrainedDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)', deviceMemory: 16 }, false)).toBe(false);
  });
  it('mobile budget stays far below iOS limits; desktop unchanged', () => {
    const MB = (px: number) => (px * 4) / 1048576;
    const mobileWorst = MB(MOBILE_PROFILE.tileBudget) + MB(MOBILE_PROFILE.maxPixels) + (MOBILE_PROFILE.baseCachePages + 1) * MB(2048 * 1448);
    expect(mobileWorst).toBeLessThan(150);
    expect(DESKTOP_PROFILE.tileBudget).toBe(36 * 1048576);
  });
});
