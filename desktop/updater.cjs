/**
 * Web-content updater for the desktop shell (required by main.cjs; plain Node, no
 * Electron APIs, so it is unit-tested with node: desktop/test/updater.test.cjs).
 *
 * The web build publishes `app-version.json` (src/pwa/appVersionPlugin.ts) at the
 * site root: buildId, builtAt, minDesktopVersion, every file with size + SHA-256, and
 * the text of index.html (login-gated on the web, so it is embedded). All other files
 * are fetched from their public paths (/assets/..., /icons/..., ...).
 *
 * Layout under userData:
 *   web-update.json         { lastSuccess, lastAttempt, preferred }  (atomic writes)
 *   web/<buildId>/          a complete, verified build (app-version.json written last,
 *                           then the whole folder renamed into place from web/.tmp-*)
 *
 * Serving: the newest of { bundled web-dist, web/<preferred> } (by builtAt; the
 * bundled build wins ties and same-buildId cases). A build downloaded while the app
 * runs becomes `pending`; it is used after applyPending() (window reload) or on the
 * next launch. At most two downloaded builds are kept (the one being served and the
 * newest). Every failure is reported as a result, never thrown at the caller.
 */
'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST = 'app-version.json';
const STATE_FILE = 'web-update.json';
const WEB_DIR = 'web';
const SCHEMA = 1;
/** Automatic checks: at most once per week (owner's requirement). */
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** While running, re-evaluate the weekly rule this often. */
const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60 * 1000;
const CONCURRENCY = 4;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

// ---------------------------------------------------------------- pure helpers (mirror src/pwa/appVersion.ts)

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v == null ? '' : v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1 for numeric major.minor.patch versions; unparsable versions sort lowest. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function isSafeRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > 512) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[a-z]:/i.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/[<>:"|?*]/.test(seg));
}

function isAppFile(p) {
  if (!isSafeRelPath(p)) return false;
  if (p === 'index.html') return true;
  if (p === 'sw.js' || p === MANIFEST || p.startsWith('tools/') || p.endsWith('.map') || /\.html$/i.test(p)) return false;
  return true;
}

/** Error string, or null when `m` is a well-formed manifest. */
function validateManifest(m) {
  if (!m || typeof m !== 'object') return 'not an object';
  if (m.schema !== SCHEMA) return 'unsupported schema';
  if (typeof m.buildId !== 'string' || !/^[0-9a-f]{16}$/.test(m.buildId)) return 'bad buildId';
  if (typeof m.builtAt !== 'string' || Number.isNaN(Date.parse(m.builtAt))) return 'bad builtAt';
  if (typeof m.minDesktopVersion !== 'string' || !parseVersion(m.minDesktopVersion)) return 'bad minDesktopVersion';
  if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > 5000) return 'bad files';
  const paths = new Set();
  for (const f of m.files) {
    if (!f || typeof f !== 'object') return 'bad file entry';
    if (!isAppFile(f.path)) return `bad path: ${String(f.path)}`;
    if (paths.has(f.path.toLowerCase())) return `duplicate path: ${f.path}`; // Windows: case-insensitive
    paths.add(f.path.toLowerCase());
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) return `bad size: ${f.path}`;
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return `bad sha256: ${f.path}`;
  }
  if (!paths.has('index.html')) return 'index.html missing';
  if (!m.inline || typeof m.inline !== 'object') return 'bad inline';
  for (const [p, text] of Object.entries(m.inline)) {
    if (!m.files.some((f) => f.path === p) || typeof text !== 'string') return `bad inline entry: ${p}`;
  }
  if (typeof m.inline['index.html'] !== 'string') return 'index.html not inline';
  return null;
}

/**
 * Weekly rule: due when there was never a successful check, when the last one is at
 * least `intervalMs` old, or when the clock went back by more than a day.
 */
function isCheckDue(state, now, intervalMs = CHECK_INTERVAL_MS) {
  const last = Number(state && state.lastSuccess);
  if (!Number.isFinite(last) || last <= 0) return true;
  if (last > now + 24 * 60 * 60 * 1000) return true;
  return now - last >= intervalMs;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fs.rename with retries (Windows: antivirus / indexer briefly lock fresh files). */
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(err && err.code)) throw err;
      await sleep(200 * (i + 1));
    }
  }
}

// ---------------------------------------------------------------- updater

/**
 * @param {{
 *   userDataDir: string,
 *   bundledRoot: string,
 *   appVersion: string,
 *   baseUrl: string,
 *   fetch: (url: string, init?: object) => Promise<{ ok: boolean, status: number, arrayBuffer(): Promise<ArrayBuffer> }>,
 *   now?: () => number,
 *   log?: (...args: unknown[]) => void,
 *   timeoutMs?: number,
 * }} opts
 */
function createUpdater(opts) {
  const { userDataDir, bundledRoot, appVersion } = opts;
  const baseUrl = String(opts.baseUrl).replace(/\/+$/, '');
  const fetchImpl = opts.fetch;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const timeoutMs = opts.timeoutMs || FETCH_TIMEOUT_MS;
  const webDir = path.join(userDataDir, WEB_DIR);
  const stateFile = path.join(userDataDir, STATE_FILE);

  /** @type {{ root: string, manifest: any, buildId: string | null, builtAtMs: number, bundled: boolean }} */
  let active = bundledInfo();
  /** Downloaded, verified, not served yet. */
  let pending = null;
  let busy = null;

  function readState() {
    const s = readJson(stateFile);
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  }

  function writeState(patch) {
    try {
      const next = { ...readState(), ...patch };
      fs.mkdirSync(userDataDir, { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      log('[updater] cannot write state', err);
    }
  }

  function bundledInfo() {
    const m = readJson(path.join(bundledRoot, MANIFEST));
    const ok = m && !validateManifest(m);
    return { root: bundledRoot, manifest: ok ? m : null, buildId: ok ? m.buildId : null, builtAtMs: ok ? Date.parse(m.builtAt) : 0, bundled: true };
  }

  /** A complete downloaded build, or null (missing / corrupt / needs a newer shell). */
  function versionInfo(buildId) {
    if (typeof buildId !== 'string' || !/^[0-9a-f]{16}$/.test(buildId)) return null;
    const root = path.join(webDir, buildId);
    const m = readJson(path.join(root, MANIFEST));
    if (!m || validateManifest(m) || m.buildId !== buildId) return null;
    if (compareVersions(appVersion, m.minDesktopVersion) < 0) return null;
    if (!fs.existsSync(path.join(root, 'index.html'))) return null;
    return { root, manifest: m, buildId, builtAtMs: Date.parse(m.builtAt), bundled: false };
  }

  /** Deletes downloaded builds and leftovers except the ids in `keep`. */
  function prune(keep) {
    let names = [];
    try {
      names = fs.readdirSync(webDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      try {
        fs.rmSync(path.join(webDir, name), { recursive: true, force: true });
      } catch (err) {
        log('[updater] cannot remove', name, err);
      }
    }
  }

  /** Picks the build to serve (applies a build downloaded during the previous run). Call once at startup. */
  function resolveServeRoot() {
    const bundled = bundledInfo();
    const preferred = versionInfo(readState().preferred);
    active = bundled;
    if (preferred && preferred.buildId !== bundled.buildId && preferred.builtAtMs > bundled.builtAtMs) active = preferred;
    pending = null;
    const keep = new Set();
    if (!active.bundled) keep.add(active.buildId);
    try {
      prune(keep);
    } catch {
      /* never block startup */
    }
    log('[updater] serving', active.bundled ? 'bundled' : 'downloaded', active.buildId);
    return active.root;
  }

  function status() {
    const last = Number(readState().lastSuccess);
    return { active: active.buildId, pending: pending ? pending.buildId : null, lastCheck: Number.isFinite(last) && last > 0 ? last : null };
  }

  async function fetchBytes(url) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ac.signal, headers: { 'Cache-Control': 'no-cache' } });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(t);
    }
  }

  const fileUrl = (p) => `${baseUrl}/${p.split('/').map(encodeURIComponent).join('/')}`;

  /** Downloads + verifies every file of `m` into web/.tmp-*, then renames it to web/<buildId>. */
  async function download(m) {
    fs.mkdirSync(webDir, { recursive: true });
    const final = path.join(webDir, m.buildId);
    const tmp = path.join(webDir, `.tmp-${m.buildId}-${process.pid}-${now()}`);
    // Unchanged files (same SHA-256) are copied from the build being served instead of downloaded.
    const local = new Map();
    if (active.manifest) for (const f of active.manifest.files) local.set(f.sha256, path.join(active.root, ...f.path.split('/')));
    let downloaded = 0;
    let copied = 0;
    try {
      fs.mkdirSync(tmp, { recursive: true });
      const queue = m.files.slice();
      let failure = null;
      const worker = async () => {
        try {
          for (let f = queue.shift(); f && !failure; f = queue.shift()) await fetchOne(f);
        } catch (err) {
          failure = failure || err;
        }
      };
      const fetchOne = async (f) => {
        let buf = null;
        if (typeof m.inline[f.path] === 'string') buf = Buffer.from(m.inline[f.path], 'utf8');
        else if (local.has(f.sha256)) {
          try {
            buf = await fsp.readFile(local.get(f.sha256));
            if (buf.length !== f.size || sha256(buf) !== f.sha256) buf = null;
            else copied++;
          } catch {
            buf = null;
          }
        }
        if (!buf) {
          buf = await fetchBytes(fileUrl(f.path));
          downloaded++;
        }
        if (buf.length !== f.size) throw new Error(`size mismatch: ${f.path} (${buf.length} != ${f.size})`);
        if (sha256(buf) !== f.sha256) throw new Error(`hash mismatch: ${f.path}`);
        const dest = path.join(tmp, ...f.path.split('/'));
        if (!dest.startsWith(tmp + path.sep)) throw new Error(`unsafe path: ${f.path}`);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, buf);
      };
      // All workers settle before cleanup, so nothing writes into tmp after it is removed.
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (failure) throw failure;
      // Completion marker last: a folder without a valid manifest is never served.
      await fsp.writeFile(path.join(tmp, MANIFEST), JSON.stringify(m));
      if (versionInfo(m.buildId)) {
        await fsp.rm(tmp, { recursive: true, force: true }); // already there (e.g. another check won the race)
      } else {
        await fsp.rm(final, { recursive: true, force: true }); // incomplete leftover with the same name
        await renameRetry(tmp, final);
      }
      log('[updater] downloaded', m.buildId, `${downloaded} fetched, ${copied} reused`);
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    const info = versionInfo(m.buildId);
    if (!info) throw new Error('downloaded build failed verification');
    return info;
  }

  async function runCheck(force) {
    const state = readState();
    if (!force && !isCheckDue(state, now())) return { status: 'skipped' };
    writeState({ lastAttempt: now() });
    try {
      const raw = await fetchBytes(`${baseUrl}/${MANIFEST}?t=${now()}`);
      let m;
      try {
        m = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new Error('manifest is not JSON');
      }
      const bad = validateManifest(m);
      if (bad) throw new Error(`invalid manifest: ${bad}`);
      writeState({ lastSuccess: now() });
      if (compareVersions(appVersion, m.minDesktopVersion) < 0) return { status: 'incompatible', buildId: m.buildId };
      if (m.buildId === active.buildId) {
        pending = null;
        writeState({ preferred: active.bundled ? null : active.buildId });
        return { status: 'up-to-date', buildId: m.buildId };
      }
      // The installed (bundled) build is newer than what the site serves: keep it.
      const bundled = bundledInfo();
      if (bundled.buildId === m.buildId || Date.parse(m.builtAt) < bundled.builtAtMs) {
        if (active.bundled) return { status: 'up-to-date', buildId: active.buildId };
      }
      if (pending && pending.buildId === m.buildId) return { status: 'pending', buildId: m.buildId };
      pending = versionInfo(m.buildId) || (await download(m));
      writeState({ preferred: m.buildId });
      const keep = new Set([m.buildId]);
      if (!active.bundled) keep.add(active.buildId);
      prune(keep);
      return { status: 'downloaded', buildId: m.buildId };
    } catch (err) {
      log('[updater] check failed', err && err.message ? err.message : err);
      return { status: 'error', error: String(err && err.message ? err.message : err) };
    }
  }

  /** Checks (weekly rule unless force) and downloads a new build. Never throws. */
  function check({ force = false } = {}) {
    if (busy) return force ? busy : Promise.resolve({ status: 'busy' });
    busy = runCheck(force).finally(() => {
      busy = null;
    });
    return busy;
  }

  /** Switches to the pending build; returns its root (serve from it, then reload) or null. */
  function applyPending() {
    if (!pending) return null;
    active = pending;
    pending = null;
    return active.root;
  }

  return {
    resolveServeRoot,
    check,
    applyPending,
    status,
    isDue: () => isCheckDue(readState(), now()),
    activeRoot: () => active.root,
  };
}

module.exports = {
  createUpdater,
  compareVersions,
  isCheckDue,
  isAppFile,
  isSafeRelPath,
  validateManifest,
  CHECK_INTERVAL_MS,
  RECHECK_EVERY_MS,
  MANIFEST,
};
