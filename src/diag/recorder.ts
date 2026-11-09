/**
 * On-device crash reporter: breadcrumbs + crash detection (see crash.ts for the detection idea).
 *
 * initDiagnostics() runs first thing in main.tsx. It
 *  - looks at the markers left by earlier sessions and decides whether one crashed,
 *  - starts this session's marker + 1 s heartbeat,
 *  - records breadcrumbs (pointers/touches, visual viewport, orientation, focus, visibility,
 *    memory, canvas memory, long tasks, errors, console.error, tool/page/zoom changes) into a
 *    ring buffer persisted to localStorage AND sessionStorage (throttled, plus on hide/pagehide).
 *
 * Storage (all keys are prefixed "pv.diag."):
 *   localStorage   alive.<sid>   AliveMarker of a running/ended session
 *                  crumbs.<sid>  its breadcrumbs
 *                  pending       { kind, session } — a crashed session waiting for "שלח דוח" / "לא עכשיו"
 *                  prev          SessionDump of the last session that ended (for the manual report)
 *   sessionStorage ss.marker / ss.crumbs — same data for this tab (fallback when localStorage is full)
 */
import { useViewer } from '../state/store';
import { subscribeZoom } from '../components/viewer/commands';
import { RingBuffer } from './ring';
import { HEARTBEAT_MS, LIVE_CHECK_MS, classifyMarker, isBenignError, isMarker, type AliveMarker, type DiagState, type Verdict } from './crash';
import { labSummary } from './lab';
import { fileLabel, scrubText, sessionDump, type Crumb, type CrumbValue, type SessionDump } from './report';

export const RING_SIZE = 300;
const P = 'pv.diag.';
const FLUSH_MS = 500;

// ------------------------------------------------------------------ storage helpers

function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // blocked (privacy settings)
  }
}
function ss(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}
function read<T>(s: Storage | null, key: string): T | null {
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(s: Storage | null, key: string, value: unknown): boolean {
  if (!s) return false;
  try {
    s.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function remove(s: Storage | null, ...keys: string[]): void {
  if (!s) return;
  for (const k of keys) {
    try {
      s.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

// ------------------------------------------------------------------ session state

const ring = new RingBuffer<Crumb>(RING_SIZE);
const state: DiagState = {};
let marker: AliveMarker | null = null;
let started = false;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const activePointers = new Map<number, string>();
let workerCount = 0;

export interface PendingCrash {
  kind: 'crash' | 'error';
  at: number;
  session: SessionDump;
}

const listeners = new Set<() => void>();
/** Called when a pending crash report appears (detection can finish ~2.5 s after load). */
export function onPendingChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const notify = () => listeners.forEach((cb) => cb());

export function getPending(): PendingCrash | null {
  return read<PendingCrash>(ls(), `${P}pending`);
}
export function clearPending(): void {
  remove(ls(), `${P}pending`);
  notify();
}
export function getPrevious(): SessionDump | null {
  return read<SessionDump>(ls(), `${P}prev`);
}
export function getCurrent(): SessionDump | null {
  if (!marker) return null;
  refreshState();
  return sessionDump({ ...marker, state: { ...state } }, ring.toArray(), 'current');
}

/** Record one breadcrumb. Values are sanitized when the report is built; keep payloads small. */
export function crumb(k: string, d?: Record<string, CrumbValue>): void {
  ring.push(d ? { t: Date.now(), k, d } : { t: Date.now(), k });
  dirty = true;
  if (!flushTimer && started) flushTimer = setTimeout(flush, FLUSH_MS);
}

export function flush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!marker) return;
  writeMarker();
  if (!dirty) return;
  dirty = false;
  const crumbs = ring.toArray();
  const json = JSON.stringify(crumbs);
  if (!write(ls(), `${P}crumbs.${marker.sid}`, json)) write(ls(), `${P}crumbs.${marker.sid}`, JSON.stringify(crumbs.slice(-100)));
  write(ss(), `${P}ss.crumbs`, json);
}

function writeMarker(): void {
  if (!marker) return;
  marker.state = { ...state };
  write(ls(), `${P}alive.${marker.sid}`, marker);
  write(ss(), `${P}ss.marker`, marker);
}

function markClean(reason: string): void {
  if (!marker) return;
  marker.clean = true;
  marker.endedAt = Date.now();
  crumb('end', { why: reason });
  flush();
}
function markAlive(): void {
  if (!marker || !marker.clean) return;
  marker.clean = false;
  delete marker.endedAt;
  marker.hb = Date.now();
  flush();
}

function recordError(kind: string, message: string, extra: Record<string, CrumbValue> = {}): void {
  const msg = scrubText(message);
  crumb(kind, { msg, ...extra });
  if (marker && !isBenignError(message)) {
    marker.errors++;
    marker.lastError = msg;
  }
  flush();
}

// ------------------------------------------------------------------ periodic sampling

let tick = 0;
function refreshState(): void {
  state.ptrs = activePointers.size;
  const vv = window.visualViewport;
  if (vv) {
    state.vvScale = Math.round(vv.scale * 1000) / 1000;
    state.vvW = Math.round(vv.width);
    state.vvH = Math.round(vv.height);
  }
  state.orient = screen.orientation?.type ?? (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait');
  state.workers = workerCount;
  state.lab = labSummary() || undefined;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (mem) state.heapMB = Math.round(mem.usedJSHeapSize / 1048576);
}

let lastCanvasMB = -1;
let lastCanvasCount = -1;
function sampleCanvases(): void {
  const list = document.getElementsByTagName('canvas');
  let bytes = 0;
  for (let i = 0; i < list.length; i++) bytes += list[i].width * list[i].height * 4;
  const mb = Math.round(bytes / 1048576);
  state.canvases = list.length;
  state.canvasMB = mb;
  if (list.length !== lastCanvasCount || Math.abs(mb - lastCanvasMB) > Math.max(4, lastCanvasMB * 0.1)) {
    lastCanvasCount = list.length;
    lastCanvasMB = mb;
    crumb('canvas', { n: list.length, mb });
  }
}

let lastHeapMB = -1;
function heartbeat(): void {
  if (!marker) return;
  tick++;
  marker.hb = Date.now();
  refreshState();
  if (tick % 2 === 0) sampleCanvases();
  if (tick % 10 === 0 && state.heapMB != null && Math.abs(state.heapMB - lastHeapMB) > Math.max(8, lastHeapMB * 0.1)) {
    lastHeapMB = state.heapMB;
    crumb('mem', { heapMB: state.heapMB });
  }
  if (dirty && !flushTimer) flush();
  else writeMarker();
}

// ------------------------------------------------------------------ detection of earlier sessions

function readCrumbs(sid: string): unknown[] {
  const fromLs = read<unknown[]>(ls(), `${P}crumbs.${sid}`);
  if (Array.isArray(fromLs) && fromLs.length) return fromLs;
  const ssMarker = read<AliveMarker>(ss(), `${P}ss.marker`);
  if (ssMarker?.sid === sid) {
    const fromSs = read<unknown[]>(ss(), `${P}ss.crumbs`);
    if (Array.isArray(fromSs)) return fromSs;
  }
  return [];
}

function readMarker(sid: string): AliveMarker | null {
  const m = read<AliveMarker>(ls(), `${P}alive.${sid}`);
  return isMarker(m) ? m : null;
}

/** Markers of earlier sessions (localStorage, plus this tab's sessionStorage copy). */
function earlierMarkers(): AliveMarker[] {
  const found = new Map<string, AliveMarker>();
  const s = ls();
  if (s) {
    const keys: string[] = [];
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k) keys.push(k);
      }
    } catch {
      /* ignore */
    }
    for (const k of keys) {
      if (k.startsWith(`${P}alive.`)) {
        const m = read<AliveMarker>(s, k);
        if (isMarker(m)) found.set(m.sid, m);
        else remove(s, k);
      }
    }
    // Orphaned crumbs (marker gone): drop.
    for (const k of keys) {
      if (k.startsWith(`${P}crumbs.`) && !found.has(k.slice(`${P}crumbs.`.length))) remove(s, k);
    }
  }
  const ssMarker = read<AliveMarker>(ss(), `${P}ss.marker`);
  if (isMarker(ssMarker) && !found.has(ssMarker.sid)) found.set(ssMarker.sid, ssMarker);
  return [...found.values()];
}

function settle(m: AliveMarker, verdict: Verdict): void {
  if (verdict === 'alive' || verdict === 'check') return;
  const crumbs = readCrumbs(m.sid);
  if (verdict === 'crashed' || verdict === 'error') {
    const pending: PendingCrash = { kind: verdict === 'crashed' ? 'crash' : 'error', at: Date.now(), session: sessionDump(m, crumbs, 'crashed') };
    const prevPending = getPending();
    if (!prevPending || prevPending.session.hb <= m.hb) {
      if (!write(ls(), `${P}pending`, pending)) write(ss(), `${P}pending`, pending);
    }
    crumb('prevCrash', { kind: pending.kind, ageS: Math.round((Date.now() - m.hb) / 1000) });
  } else {
    const prev = getPrevious();
    if (!prev || prev.hb <= m.hb) write(ls(), `${P}prev`, sessionDump(m, crumbs, 'previous'));
  }
  remove(ls(), `${P}alive.${m.sid}`, `${P}crumbs.${m.sid}`);
  notify();
}

function detectEarlierSessions(): void {
  const now = Date.now();
  // pending saved to sessionStorage because localStorage was full
  const ssPending = read<PendingCrash>(ss(), `${P}pending`);
  if (ssPending && !getPending()) write(ls(), `${P}pending`, ssPending);
  for (const m of earlierMarkers()) {
    const v = classifyMarker(m, now);
    if (v === 'check') {
      setTimeout(() => {
        const again = readMarker(m.sid);
        // sessionStorage-only marker (localStorage unavailable): it cannot be another live tab.
        settle(m, classifyMarker(m, Date.now(), again ?? (ls() ? null : m)));
      }, LIVE_CHECK_MS);
    } else settle(m, v);
  }
}

// ------------------------------------------------------------------ listeners

function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A;
  return (...a: A) => {
    lastArgs = a;
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...lastArgs);
      }, ms - (now - last));
    }
  };
}

const r = Math.round;

function installListeners(): void {
  const opts: AddEventListenerOptions = { capture: true, passive: true };

  const onPointer = (e: PointerEvent) => {
    if (e.type === 'pointerdown') activePointers.set(e.pointerId, e.pointerType);
    else activePointers.delete(e.pointerId);
    state.ptrs = activePointers.size;
    crumb(e.type === 'pointerdown' ? 'pdown' : e.type === 'pointerup' ? 'pup' : 'pcancel', {
      n: activePointers.size,
      pt: e.pointerType,
      x: r(e.clientX),
      y: r(e.clientY),
    });
  };
  window.addEventListener('pointerdown', onPointer, opts);
  window.addEventListener('pointerup', onPointer, opts);
  window.addEventListener('pointercancel', onPointer, opts);

  const onTouch = (e: TouchEvent) => {
    state.touches = e.touches.length;
    const t = e.changedTouches[0];
    crumb(e.type === 'touchstart' ? 'tstart' : e.type === 'touchend' ? 'tend' : 'tcancel', {
      n: e.touches.length,
      ch: e.changedTouches.length,
      ...(t ? { x: r(t.clientX), y: r(t.clientY) } : {}),
    });
  };
  window.addEventListener('touchstart', onTouch, opts);
  window.addEventListener('touchend', onTouch, opts);
  window.addEventListener('touchcancel', onTouch, opts);
  // iOS Safari pinch on the page itself
  window.addEventListener('gesturestart', () => crumb('gesture', { s: 'start' }), opts);
  window.addEventListener('gestureend', () => crumb('gesture', { s: 'end' }), opts);

  const vv = window.visualViewport;
  if (vv) {
    const onVv = throttle(() => crumb('vv', { s: r(vv.scale * 1000) / 1000, w: r(vv.width), h: r(vv.height), ox: r(vv.offsetLeft), oy: r(vv.offsetTop) }), 300);
    vv.addEventListener('resize', onVv);
    vv.addEventListener('scroll', onVv);
  }
  window.addEventListener('resize', throttle(() => crumb('resize', { w: window.innerWidth, h: window.innerHeight }), 300));
  const onOrient = () => crumb('orient', { type: screen.orientation?.type ?? '', angle: screen.orientation?.angle ?? 0 });
  if (screen.orientation) screen.orientation.addEventListener('change', onOrient);
  else window.addEventListener('orientationchange', onOrient);

  window.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement | null;
    crumb('focus', { tag: el?.tagName?.toLowerCase() ?? '', type: (el as HTMLInputElement | null)?.type ?? '' });
  }, true);
  window.addEventListener('blur', () => crumb('wblur'));
  window.addEventListener('focus', () => crumb('wfocus'));

  document.addEventListener('visibilitychange', () => {
    crumb('vis', { s: document.visibilityState });
    if (document.visibilityState === 'hidden') markClean('hidden');
    else markAlive();
  });
  window.addEventListener('pagehide', (e) => {
    crumb('pagehide', { persisted: e.persisted });
    markClean('pagehide');
  });
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    crumb('pageshow', { persisted: true });
    markAlive();
  });
  document.addEventListener('freeze', () => {
    crumb('freeze');
    flush();
  });
  document.addEventListener('resume', () => crumb('resume'));
  window.addEventListener('online', () => crumb('net', { online: true }));
  window.addEventListener('offline', () => crumb('net', { online: false }));

  // errors
  window.addEventListener(
    'error',
    (e: Event) => {
      if (e instanceof ErrorEvent) {
        recordError('error', e.message || String(e.error ?? ''), {
          src: (e.filename || '').split('/').pop()?.split('?')[0] ?? '',
          line: e.lineno || 0,
          col: e.colno || 0,
          stack: scrubText((e.error as Error | undefined)?.stack ?? '', 600),
        });
      } else {
        const el = e.target as HTMLElement | null;
        crumb('reserr', { tag: el?.tagName?.toLowerCase() ?? '' });
      }
    },
    true,
  );
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { message?: string; name?: string; stack?: string } | undefined;
    recordError('rejection', reason?.message ?? String(reason ?? ''), { name: reason?.name ?? '', stack: scrubText(reason?.stack ?? '', 600) });
  });

  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      crumb('console', { msg: scrubText(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a))).join(' ')) });
    } catch {
      /* never break console.error */
    }
    origError(...args);
  };

  try {
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) crumb('longtask', { ms: r(entry.duration) });
      }).observe({ type: 'longtask', buffered: true });
    }
  } catch {
    /* unsupported */
  }

  wrapWorker();

  // App state (tool / page / measurement count / docs / draft) — counts only, never names or text.
  const snap = (s: ReturnType<typeof useViewer.getState>) => ({
    tool: s.tool,
    page: s.currentPage,
    pages: s.numPages,
    docs: s.docs.length,
    meas: s.measurements.length,
    draft: s.draft.length,
    loading: s.loading,
    err: !!s.error,
  });
  let prev = snap(useViewer.getState());
  Object.assign(state, { tool: prev.tool, page: prev.page, pages: prev.pages, docs: prev.docs, meas: prev.meas, draft: prev.draft });
  useViewer.subscribe((s) => {
    const next = snap(s);
    if (next.tool !== prev.tool) crumb('tool', { tool: next.tool, from: prev.tool });
    if (next.page !== prev.page) crumb('page', { page: next.page });
    if (next.docs !== prev.docs || next.pages !== prev.pages) crumb('docs', { docs: next.docs, pages: next.pages, file: fileLabel(s.fileName) });
    if (next.meas !== prev.meas) crumb('meas', { n: next.meas });
    if ((next.draft === 0) !== (prev.draft === 0)) crumb('draft', { n: next.draft });
    if (next.loading !== prev.loading) crumb('loading', { on: next.loading });
    if (next.err && !prev.err) crumb('appError', { len: s.error?.length ?? 0 });
    Object.assign(state, { tool: next.tool, page: next.page, pages: next.pages, docs: next.docs, meas: next.meas, draft: next.draft });
    prev = next;
  });

  // Zoom (also fires every frame during pinch): state always, crumb at most every 250 ms.
  const zoomCrumb = throttle((z: number) => crumb('zoom', { z }), 250);
  subscribeZoom((percent) => {
    const z = r(percent * 10) / 10;
    if (z === state.zoom) return;
    state.zoom = z;
    if (started) zoomCrumb(z);
  });
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 200) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Count workers and record their errors (pdf.js / render workers are created with `new Worker`). */
function wrapWorker(): void {
  try {
    const Orig = window.Worker as typeof Worker & { __diag?: boolean };
    if (!Orig || Orig.__diag) return;
    class DiagWorker extends Orig {
      static __diag = true;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workerCount++;
        crumb('worker', { n: workerCount });
        this.addEventListener('error', (e) => recordError('workerError', (e as ErrorEvent).message || 'worker error'));
        this.addEventListener('messageerror', () => crumb('workerMsgError'));
      }
      terminate(): void {
        workerCount = Math.max(0, workerCount - 1);
        crumb('workerEnd', { n: workerCount });
        super.terminate();
      }
    }
    window.Worker = DiagWorker;
  } catch {
    /* leave Worker alone */
  }
}

// ------------------------------------------------------------------ init

const newSid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Start recording (idempotent). Call as early as possible. */
export function initDiagnostics(): void {
  if (started || typeof window === 'undefined') return;
  try {
    detectEarlierSessions();
    const now = Date.now();
    marker = { v: 1, sid: newSid(), start: now, hb: now, clean: document.visibilityState === 'hidden', errors: 0, state };
    started = true;
    refreshState();
    crumb('boot', {
      vis: document.visibilityState,
      standalone: isStandalone(),
      sw: !!navigator.serviceWorker?.controller,
      dpr: window.devicePixelRatio,
    });
    installListeners();
    flush();
    setInterval(heartbeat, HEARTBEAT_MS);
  } catch (err) {
    // Diagnostics must never break the app.
    started = true;
    void err;
  }
}

export function isStandalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** Device info for the report (no identifiers beyond what any web server sees). */
export function deviceInfo(): Record<string, CrumbValue> {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string; mobile?: boolean }; connection?: { effectiveType?: string } };
  const vv = window.visualViewport;
  return {
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform ?? nav.platform ?? '',
    mobile: nav.userAgentData?.mobile ?? null,
    screenW: screen.width,
    screenH: screen.height,
    dpr: window.devicePixelRatio,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    vvScale: vv ? vv.scale : null,
    deviceMemory: nav.deviceMemory ?? null,
    cores: nav.hardwareConcurrency ?? null,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: isStandalone(),
    lang: nav.language,
    online: nav.onLine,
    net: nav.connection?.effectiveType ?? null,
    swControlled: !!navigator.serviceWorker?.controller,
  };
}

/** Hashed name of the bundle chunk this module is in (identifies the build even without app-version.json). */
export function buildAsset(): string {
  try {
    return new URL(import.meta.url).pathname.split('/').pop() ?? '';
  } catch {
    return '';
  }
}

export async function fetchBuildId(timeoutMs = 2000): Promise<string | undefined> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch('/app-version.json', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
    const v = (await res.json()) as { buildId?: unknown; builtAt?: unknown };
    return typeof v.buildId === 'string' ? `${v.buildId}${typeof v.builtAt === 'string' ? ` (${v.builtAt})` : ''}` : undefined;
  } catch {
    return undefined;
  }
}
