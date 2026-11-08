import { describe, expect, it } from 'vitest';
import { createWheelPager } from './wheelPager';

describe('wheel pager', () => {
  it('one mouse notch = one page; next notch after a pause = next page', () => {
    const w = createWheelPager();
    expect(w.push(100, 0)).toBe(1);
    expect(w.push(100, 400)).toBe(1);
    expect(w.push(-100, 800)).toBe(-1);
  });
  it('a trackpad swipe with momentum flips only once', () => {
    const w = createWheelPager();
    const out: number[] = [];
    for (let t = 0; t < 900; t += 16) out.push(w.push(12, t));
    expect(out.filter(Boolean)).toEqual([1]);
  });
  it('a fast continuous spin flips once until the wheel rests', () => {
    const w = createWheelPager();
    const steps = [0, 50, 100, 150].map((t) => w.push(100, t));
    expect(steps).toEqual([1, 0, 0, 0]);
    expect(w.push(100, 150 + 200)).toBe(1);
  });
  it('reversing direction mid-gesture flips back at once', () => {
    const w = createWheelPager();
    expect(w.push(100, 0)).toBe(1);
    expect(w.push(-100, 60)).toBe(-1);
  });
  it('tiny jitter does not flip', () => {
    const w = createWheelPager();
    expect(w.push(5, 0)).toBe(0);
    expect(w.push(5, 500)).toBe(0);
  });
});
