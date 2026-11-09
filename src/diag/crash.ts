/**
 * Crash detection (pure logic; wiring in recorder.ts).
 *
 * Every page load writes an "alive" marker (localStorage + sessionStorage) and refreshes its
 * heartbeat `hb` every second. A clean exit (pagehide / visibility hidden) sets `clean: true`.
 * iOS kills a tab under memory pressure without pagehide, so on the next load a marker that is
 * still unclean with a recent heartbeat means the previous session crashed. Other open tabs also
 * hold unclean markers, so a recent-looking marker is re-read after LIVE_CHECK_MS: a live tab has
 * moved its heartbeat by then, a dead one has not.
 */

/** Last-known app/device state, refreshed with every heartbeat. */
export interface DiagState {
  /** Active crash-lab switches (see lab.ts). */
  lab?: string;
  tool?: string;
  page?: number;
  pages?: number;
  docs?: number;
  meas?: number;
  draft?: number;
  zoom?: number;
  ptrs?: number;
  touches?: number;
  vvScale?: number;
  vvW?: number;
  vvH?: number;
  canvases?: number;
  canvasMB?: number;
  /** Viewer raster memory (tiles + base + cached base bitmaps), MB. */
  rasterMB?: number;
  heapMB?: number;
  workers?: number;
  orient?: string;
}

export interface AliveMarker {
  v: 1;
  sid: string;
  start: number;
  /** Last heartbeat (ms epoch). */
  hb: number;
  clean: boolean;
  endedAt?: number;
  /** Uncaught errors seen in this session. */
  errors: number;
  lastError?: string;
  state: DiagState;
}

export const HEARTBEAT_MS = 1000;
/** A dead session whose last heartbeat is older than this is not reported (phone off, tab long gone…). */
export const CRASH_WINDOW_MS = 2 * 60 * 1000;
/** Wait this long before re-reading a recent-looking marker (other live tabs heartbeat meanwhile). */
export const LIVE_CHECK_MS = 2500;
/** A heartbeat this old cannot belong to a live foreground tab: no re-check needed. */
export const DEAD_AFTER_MS = 6000;

export type Verdict =
  /** Exited cleanly. */
  | 'ended'
  /** Exited cleanly but had uncaught errors: offer a report. */
  | 'error'
  /** Unclean, but too long ago to report. */
  | 'stale'
  /** Unclean and recent: re-read after LIVE_CHECK_MS to tell a crash from another live tab. */
  | 'check'
  | 'crashed'
  /** Another tab that is still running. */
  | 'alive';

/**
 * @param recheck  undefined on the first look; on the re-check, the marker as re-read
 *                 (null when it disappeared meanwhile).
 */
export function classifyMarker(m: AliveMarker, now: number, recheck?: AliveMarker | null): Verdict {
  if (m.clean) return m.errors > 0 ? 'error' : 'ended';
  if (now - m.hb > CRASH_WINDOW_MS) return 'stale';
  if (recheck === undefined) return now - m.hb > DEAD_AFTER_MS ? 'crashed' : 'check';
  if (recheck === null) return 'ended';
  if (recheck.clean) return recheck.errors > 0 ? 'error' : 'ended';
  if (recheck.hb !== m.hb) return 'alive';
  return 'crashed';
}

export function isMarker(x: unknown): x is AliveMarker {
  const m = x as AliveMarker | null;
  return !!m && typeof m === 'object' && m.v === 1 && typeof m.sid === 'string' && typeof m.hb === 'number' && typeof m.start === 'number' && typeof m.clean === 'boolean';
}

/** Messages that are noise rather than failures (never count as a crash). */
export function isBenignError(message: string): boolean {
  return /ResizeObserver loop|Script error\.?$|AbortError|The operation was aborted/i.test(message);
}
