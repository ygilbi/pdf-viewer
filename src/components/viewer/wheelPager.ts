/**
 * Turns wheel events into page steps: one page per scroll gesture.
 *
 * A mouse notch (~100 px) flips at once; trackpad scrolling (many small deltas plus momentum)
 * accumulates until THRESHOLD and then flips once. After a flip further events are swallowed
 * until the wheel has been quiet for QUIET_MS, so a single swipe or a fast spin never skips
 * several pages. A change of direction is honoured immediately.
 */
export const WHEEL_THRESHOLD = 40;
export const WHEEL_QUIET_MS = 180;

export interface WheelPager {
  /** Feed a vertical delta (px) at time `now` (ms); returns +1 / -1 to change page, else 0. */
  push(dy: number, now: number): -1 | 0 | 1;
}

export function createWheelPager(threshold = WHEEL_THRESHOLD, quietMs = WHEEL_QUIET_MS): WheelPager {
  let acc = 0;
  let last = -Infinity;
  let locked: -1 | 0 | 1 = 0; // direction of the last flip while the gesture continues
  return {
    push(dy, now) {
      if (!dy) return 0;
      const dir = dy > 0 ? 1 : -1;
      if (now - last > quietMs) {
        locked = 0;
        acc = 0;
      }
      last = now;
      if (locked === dir) return 0; // same gesture (or its momentum) — already flipped
      if (locked !== 0 || Math.sign(acc) !== dir) acc = 0; // reversed direction
      locked = 0;
      acc += dy;
      if (Math.abs(acc) >= threshold) {
        acc = 0;
        locked = dir;
        return dir;
      }
      return 0;
    },
  };
}
