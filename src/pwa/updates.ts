/**
 * Software updates — one state for both targets, rendered by UpdateToast.tsx.
 *
 * Web / PWA: the service worker (swTemplate.ts) installs a new build by itself
 * (skipWaiting + clients.claim). This module makes the browser look for one on load
 * (registration), whenever the tab becomes visible again, when the network comes
 * back and every hour, and reports "a new version took control" once the new worker
 * says the page's own entry script is not part of its build.
 *
 * Windows desktop: the Electron shell (desktop/updater.cjs) downloads new web builds
 * itself (weekly, or on demand) and tells the page through window.pdfDesktop.
 *
 * Applying = reloading the page (web) or the window onto the new build (desktop).
 */
import { create } from 'zustand';
import { getDesktop } from '../desktop/bridge';

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'up-to-date' | 'ready' | 'incompatible' | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** Where the update came from. */
  kind: 'web' | 'desktop';
  /** The last status came from a user-triggered check (show transient results). */
  manual: boolean;
  /** Desktop: page offering a new installer (status 'incompatible'). */
  downloadUrl: string | null;
  /** The user closed the "ready" toast (a manual check shows it again). */
  dismissed: boolean;
}

export const useUpdates = create<UpdateState>(() => ({
  status: 'idle',
  kind: getDesktop() ? 'desktop' : 'web',
  manual: false,
  downloadUrl: null,
  dismissed: false,
}));

const setStatus = (status: UpdateStatus, extra: Partial<UpdateState> = {}) => {
  // Never downgrade a ready update to a transient check result.
  if (useUpdates.getState().status === 'ready' && status !== 'ready') return;
  useUpdates.setState({ status, ...extra });
};

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Visibility / online checks closer together than this are skipped. */
const MIN_CHECK_GAP_MS = 60 * 1000;
const VERSION_REPLY_TIMEOUT_MS = 3000;

// ------------------------------------------------------------------ web (service worker)

let registration: ServiceWorkerRegistration | null = null;

/** Module entry scripts of this page (index.html), as absolute URLs. */
function pageEntryScripts(): string[] {
  return Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
    .map((s) => s.src)
    .filter((u) => /\/assets\//.test(u));
}

/**
 * True when every entry script of the running page belongs to the build of `sw`
 * (= the page already runs that build). Old workers that do not answer count as a different build.
 */
export function entryScriptsInBuild(entries: readonly string[], assets: readonly string[]): boolean {
  if (!entries.length) return true; // nothing to compare (dev): never claim an update
  const set = new Set(assets);
  return entries.every((u) => set.has(u.split('#')[0].split('?')[0]));
}

function askVersion(sw: ServiceWorker): Promise<{ version: string; assets: string[] } | null> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = window.setTimeout(() => resolve(null), VERSION_REPLY_TIMEOUT_MS);
    ch.port1.onmessage = (e) => {
      window.clearTimeout(t);
      const d = e.data as { version?: unknown; assets?: unknown } | null;
      resolve(d && Array.isArray(d.assets) ? { version: String(d.version), assets: d.assets.map(String) } : null);
    };
    try {
      sw.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
    } catch {
      window.clearTimeout(t);
      resolve(null);
    }
  });
}

/** Called by register.ts once the service worker is registered. */
export function watchServiceWorker(reg: ServiceWorkerRegistration): void {
  registration = reg;
  const sw = navigator.serviceWorker;
  let controller = sw.controller;
  sw.addEventListener('controllerchange', () => {
    const prev = controller;
    controller = sw.controller;
    // prev === null: first install — this page was loaded from the network, nothing to update.
    if (!prev || !controller) return;
    const next = controller;
    void askVersion(next).then((info) => {
      if (info && entryScriptsInBuild(pageEntryScripts(), info.assets)) return; // page already runs this build
      setStatus('ready', { kind: 'web' });
    });
  });

  let last = Date.now(); // register() itself just checked
  const check = (force = false) => {
    if (!force && Date.now() - last < MIN_CHECK_GAP_MS) return;
    last = Date.now();
    reg.update().catch(() => {
      /* offline / server error: try again later */
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  window.addEventListener('online', () => check());
  window.setInterval(() => check(true), UPDATE_CHECK_INTERVAL_MS);
}

// ------------------------------------------------------------------ desktop

let desktopInit = false;

/** Subscribes to the desktop shell's update notifications (idempotent; no-op on the web). */
export function initDesktopUpdates(): void {
  const d = getDesktop();
  if (!d || desktopInit) return;
  desktopInit = true;
  d.onUpdateReady?.(() => setStatus('ready', { kind: 'desktop' }));
  void d
    .getUpdateState?.()
    .then((s) => {
      if (s && s.pending) setStatus('ready', { kind: 'desktop' });
    })
    .catch(() => {});
}

// ------------------------------------------------------------------ actions

/** "בדוק עדכונים": checks now, whatever the schedule. Result goes to the store (manual = true). */
export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  const d = getDesktop();
  if (useUpdates.getState().status === 'ready') {
    useUpdates.setState({ manual: true, dismissed: false });
    return 'ready';
  }
  setStatus('checking', { manual: true });
  try {
    if (d) {
      if (!d.checkForUpdates) throw new Error('this desktop version cannot update itself');
      const r = await d.checkForUpdates();
      if (r.status === 'downloaded' || r.status === 'pending') setStatus('ready', { kind: 'desktop' });
      else if (r.status === 'up-to-date') setStatus('up-to-date');
      else if (r.status === 'incompatible') setStatus('incompatible', { downloadUrl: r.downloadUrl ?? null });
      else setStatus('error');
    } else {
      const reg = registration;
      if (!reg) {
        setStatus('up-to-date'); // no service worker (dev / unsupported): the page is always fresh from the server
      } else {
        await reg.update();
        const incoming = reg.installing ?? reg.waiting;
        if (incoming) {
          setStatus('downloading');
          if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
        } else setStatus('up-to-date');
      }
    }
  } catch (err) {
    console.warn('[updates] check failed', err);
    setStatus('error');
  }
  return useUpdates.getState().status;
}

const RELOAD_MARK = 'pv:update-reload-at';
/** No second automatic reload within this time (protects against a reload loop). */
export const AUTO_RELOAD_GUARD_MS = 5 * 60 * 1000;

export function recentlyAutoReloaded(now = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_MARK));
    return Number.isFinite(at) && at > 0 && now - at < AUTO_RELOAD_GUARD_MS;
  } catch {
    return false;
  }
}

/** Switches to the new version: reload (web) / reload onto the downloaded build (desktop). */
export async function applyUpdate(auto = false): Promise<void> {
  if (auto) {
    try {
      sessionStorage.setItem(RELOAD_MARK, String(Date.now()));
    } catch {
      /* storage blocked */
    }
  }
  const d = getDesktop();
  if (d && useUpdates.getState().kind === 'desktop' && d.applyUpdate) {
    await d.applyUpdate();
    return;
  }
  window.location.reload();
}
