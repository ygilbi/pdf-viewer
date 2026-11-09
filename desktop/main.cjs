/**
 * PDF Viewer — Electron main process (Windows desktop app).
 *
 * - Serves the built web app (desktop/web-dist) from the privileged scheme
 *   app://pdf-viewer/ (module workers, fetch, IndexedDB and dynamic imports all
 *   need a real standard/secure origin; file:// breaks them).
 * - Single instance: PDFs from the command line (double-click / "Open with")
 *   of the first and of later launches are read here and handed to the renderer
 *   over IPC once it says it is ready (preload.cjs → window.pdfDesktop).
 * - Default-app check reads the per-user UserChoice ProgId (read-only: Windows
 *   hash-protects UserChoice, no app may set it); the Settings deep link opens
 *   THIS app's page in Settings › Apps › Default apps.
 * - Small persistent preferences (userData/prefs.json, allow-listed keys) for the
 *   one-time "make PDF Viewer the default?" question: the renderer's localStorage
 *   is per-origin and can be cleared, this file survives (also uninstall +
 *   reinstall: deleteAppDataOnUninstall is false, so it is asked once per Windows user).
 *
 * - Web-content updates (updater.cjs): the app checks the site's app-version.json at most
 *   once a week (re-evaluated at startup and every 6 hours) or on demand ("בדוק עדכונים"),
 *   downloads a new web build into userData/web/<buildId>/ and serves it after a window
 *   reload / the next launch. Changes to THIS file / preload.cjs still need a new installer.
 *   PDF_VIEWER_UPDATE_URL overrides the site; PDF_VIEWER_NO_AUTO_UPDATE=1 (and smoke-test
 *   captures) disable the automatic checks.
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, protocol, screen, shell } = require('electron');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createUpdater, RECHECK_EVERY_MS } = require('./updater.cjs');

const SCHEME = 'app';
const HOST = 'pdf-viewer';
const ORIGIN = `${SCHEME}://${HOST}`;
const PROG_ID = 'PDFViewer.Document';
const DEFAULT_APPS_URI = 'ms-settings:defaultapps?registeredAppUser=PDF%20Viewer';
const BG = '#0f172a';
const WEB_ROOT = path.join(__dirname, 'web-dist');
const ICON = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const MAX_PDF_BYTES = 2 * 1024 * 1024 * 1024; // refuse absurd sizes instead of crashing on readFile
const UPDATE_BASE_URL = (process.env.PDF_VIEWER_UPDATE_URL || 'https://pdf-viewer-lemon.vercel.app').replace(/\/+$/, '');
/** First automatic update check after startup (the weekly rule decides whether it hits the network). */
const FIRST_UPDATE_CHECK_MS = 20 * 1000;

app.setName('PDF Viewer');
if (process.platform === 'win32') app.setAppUserModelId('com.ygilbi.pdfviewer');

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
]);

// ---------------------------------------------------------------- single instance

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return; // CommonJS module scope: stop here in the second instance
}

/** @type {BrowserWindow | null} */
let win = null;
let rendererReady = false;
/** PDF paths waiting for the renderer. */
let pending = [];
/** Folder of the last PDF opened from Explorer / the command line (default folder of "שמור בשם"). */
let lastOpenDir = null;

/** PDF paths among command-line args (Chromium switches and the app path are skipped). */
function pdfPathsFromArgv(argv, cwd) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const out = [];
  for (const a of args) {
    if (!a || a.startsWith('--') || !/\.pdf$/i.test(a)) continue;
    const p = path.resolve(cwd || process.cwd(), a);
    try {
      if (fs.statSync(p).isFile()) out.push(p);
    } catch {
      /* not a file */
    }
  }
  return out;
}

function queueFiles(paths) {
  if (!paths.length) return;
  pending.push(...paths);
  flush();
}

async function flush() {
  if (!win || win.isDestroyed() || !rendererReady || !pending.length) return;
  const paths = pending;
  pending = [];
  const files = [];
  for (const p of paths) {
    try {
      const st = await fs.promises.stat(p);
      if (st.size > MAX_PDF_BYTES) throw new Error('file too large');
      const buf = await fs.promises.readFile(p);
      files.push({ name: path.basename(p), bytes: buf });
      lastOpenDir = path.dirname(p);
    } catch (err) {
      console.error('[desktop] cannot read', p, err);
    }
  }
  if (process.env.PDF_VIEWER_DEBUG) console.log('[desktop] sending', files.map((f) => `${f.name} (${f.bytes.length} B)`).join(', '));
  if (files.length && win && !win.isDestroyed()) win.webContents.send('pdf:open-files', files);
}

function focusWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.on('second-instance', (_e, argv, workingDirectory) => {
  if (process.env.PDF_VIEWER_DEBUG) console.log('[desktop] second-instance', JSON.stringify({ argv, workingDirectory }));
  queueFiles(pdfPathsFromArgv(argv, workingDirectory));
  focusWindow();
});

// macOS Finder "Open with" (not a shipping target, but harmless)
app.on('open-file', (e, p) => {
  e.preventDefault();
  queueFiles([p]);
});

queueFiles(pdfPathsFromArgv(process.argv, process.cwd()));

// ---------------------------------------------------------------- window state

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  const def = { width: 1280, height: 860, maximized: true };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const st = {
      width: Math.max(640, Number(s.width) || def.width),
      height: Math.max(480, Number(s.height) || def.height),
      maximized: !!s.maximized,
    };
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      // only restore the position if it is still on a connected display
      const visible = screen.getAllDisplays().some(({ workArea: a }) => s.x < a.x + a.width - 50 && s.x + 100 > a.x && s.y >= a.y - 10 && s.y < a.y + a.height - 50);
      if (visible) Object.assign(st, { x: s.x, y: s.y });
    }
    return st;
  } catch {
    return def;
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch (err) {
    console.warn('[desktop] cannot save window state', err);
  }
}

// ---------------------------------------------------------------- default app (Windows)

/**
 * True when the user's .pdf choice is our ProgID, false when it is another app,
 * null when unknown (not Windows / no UserChoice at all / reg failed).
 * Windows 11 24H2+ also writes UserChoiceLatest (with a ProgId subkey); it wins when present.
 */
function isDefaultPdfApp() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf';
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key, '/s'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      /** @type {Record<string, string>} */
      const progIds = {};
      let cur = '';
      for (const line of String(stdout).split(/\r?\n/)) {
        if (/^HKEY_/i.test(line)) cur = line.trim().replace(/^.*\\FileExts\\\.pdf\\?/i, '');
        const m = /^\s+ProgId\s+REG_SZ\s+(.*)$/i.exec(line);
        if (m) progIds[cur.toLowerCase()] = m[1].trim();
      }
      const choice =
        progIds['userchoicelatest\\progid'] ?? progIds['userchoicelatest'] ?? progIds['userchoice'] ?? null;
      resolve(choice == null ? null : choice.toLowerCase() === PROG_ID.toLowerCase());
    });
  });
}

// ---------------------------------------------------------------- preferences (userData/prefs.json)

/** Keys the renderer may read / write. defaultPdfPrompt = {answered, answer, at} of the one-time question. */
const PREF_KEYS = new Set(['defaultPdfPrompt']);
const MAX_PREF_BYTES = 4096;
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');

function readPrefs() {
  try {
    const v = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {}; // missing or corrupt
  }
}

function writePrefs(prefs) {
  const file = prefsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
  fs.renameSync(tmp, file); // atomic replace: never a half-written prefs.json
}

// ---------------------------------------------------------------- web-content updates

/** Root the app:// handler serves from: bundled web-dist or a downloaded build (updater.cjs). */
let webRoot = WEB_ROOT;
/** @type {ReturnType<typeof createUpdater> | null} */
let updater = null;

function initUpdater() {
  try {
    updater = createUpdater({
      userDataDir: app.getPath('userData'),
      bundledRoot: WEB_ROOT,
      appVersion: app.getVersion(),
      baseUrl: UPDATE_BASE_URL,
      fetch: (url, init) => net.fetch(url, init),
      log: (...a) => {
        if (process.env.PDF_VIEWER_DEBUG) console.log(...a);
      },
    });
    webRoot = updater.resolveServeRoot();
  } catch (err) {
    console.error('[desktop] updater unavailable', err);
    updater = null;
    webRoot = WEB_ROOT;
  }
}

function notifyUpdateReady() {
  if (updater && win && !win.isDestroyed()) win.webContents.send('pdf:update-ready', updater.status());
}

async function runUpdateCheck(force) {
  if (!updater) return { status: 'error', error: 'updater unavailable' };
  try {
    const r = await updater.check({ force });
    if (r.status === 'downloaded' || r.status === 'pending') notifyUpdateReady();
    if (r.status === 'incompatible') return { ...r, downloadUrl: `${UPDATE_BASE_URL}/download` };
    return r;
  } catch (err) {
    return { status: 'error', error: String(err) };
  }
}

function scheduleUpdateChecks() {
  if (!updater || process.env.PDF_VIEWER_CAPTURE || process.env.PDF_VIEWER_NO_AUTO_UPDATE === '1') return;
  setTimeout(() => void runUpdateCheck(false), FIRST_UPDATE_CHECK_MS);
  setInterval(() => void runUpdateCheck(false), RECHECK_EVERY_MS);
}

// ---------------------------------------------------------------- app:// protocol

function registerProtocol() {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    // The desktop app never uses the PWA service worker (or its PowerShell icon tool).
    if (rel === '/sw.js' || rel.startsWith('/tools/')) return new Response('Not found', { status: 404 });
    const root = webRoot;
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      if (!(await fs.promises.stat(file)).isFile()) throw new Error('not a file');
    } catch {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ---------------------------------------------------------------- window

function isAppUrl(u) {
  try {
    // Not `.origin`: Node's URL does not know app:// is a standard scheme and reports origin "null".
    const url = new URL(u);
    return url.protocol === `${SCHEME}:` && url.host === HOST;
  } catch {
    return false;
  }
}

function openExternalSafe(u) {
  try {
    const { protocol: p } = new URL(u);
    if (p === 'https:' || p === 'http:' || p === 'mailto:' || u.startsWith('ms-settings:')) void shell.openExternal(u);
  } catch {
    /* ignore malformed */
  }
}

function createWindow() {
  const st = loadWindowState();
  win = new BrowserWindow({
    title: 'PDF Viewer',
    icon: ICON,
    backgroundColor: BG,
    show: false,
    autoHideMenuBar: true,
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 640,
    minHeight: 480,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win && win.show());

  // Keep the product name in the title bar (index.html's <title> is the Hebrew web title).
  win.on('page-title-updated', (e) => e.preventDefault());

  const wc = win.webContents;
  if (process.env.PDF_VIEWER_DEBUG) wc.on('console-message', (e) => console.log('[renderer]', e.level, e.message));
  wc.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url) && !url.startsWith('blob:')) openExternalSafe(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openExternalSafe(url);
  });
  wc.on('did-start-loading', () => {
    rendererReady = false; // reload: wait for the new page to subscribe again
  });
  wc.on('render-process-gone', () => {
    rendererReady = false;
  });

  let saveTimer = null;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('close', saveWindowState);
  win.on('closed', () => {
    win = null;
  });

  void win.loadURL(`${ORIGIN}/index.html`);
}

// ---------------------------------------------------------------- IPC

ipcMain.on('pdf:version', (e) => {
  e.returnValue = app.getVersion();
});
ipcMain.on('pdf:renderer-ready', (e) => {
  if (!win || e.sender !== win.webContents) return;
  rendererReady = true;
  void flush();
});
ipcMain.handle('pdf:is-default', () => isDefaultPdfApp());

/** Only our own page (app://pdf-viewer) may touch the preferences. */
function fromApp(e) {
  return !!win && e.sender === win.webContents && isAppUrl(e.senderFrame ? e.senderFrame.url : e.sender.getURL());
}
ipcMain.handle('pdf:get-pref', (e, key) => {
  if (!fromApp(e) || !PREF_KEYS.has(key)) throw new Error('pref not allowed');
  const v = readPrefs()[key];
  return v === undefined ? null : v;
});
ipcMain.handle('pdf:set-pref', (e, key, value) => {
  if (!fromApp(e) || !PREF_KEYS.has(key)) throw new Error('pref not allowed');
  const json = JSON.stringify(value === undefined ? null : value);
  if (json.length > MAX_PREF_BYTES) throw new Error('pref too large');
  const prefs = readPrefs();
  prefs[key] = JSON.parse(json);
  writePrefs(prefs);
});
ipcMain.handle('pdf:update-check', (e) => {
  if (!fromApp(e)) throw new Error('not allowed');
  return runUpdateCheck(true);
});
ipcMain.handle('pdf:update-state', (e) => {
  if (!fromApp(e)) throw new Error('not allowed');
  return updater ? updater.status() : { active: null, pending: null, lastCheck: null };
});
ipcMain.handle('pdf:update-apply', (e) => {
  if (!fromApp(e) || !updater) return false;
  const root = updater.applyPending();
  if (!root) return false;
  webRoot = root;
  // Reload after replying so the renderer's promise settles first.
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
  }, 50);
  return true;
});
// "שמור בשם" (Save As): the renderer builds the PDF; main asks WHERE (native dialog) and writes it.
// Two steps so the dialog comes before the (possibly long) build. The renderer never passes a
// path: saveAsChoose hands out a one-time token for the path the user picked in OUR dialog.
/** token → absolute path chosen in the Save dialog (one write each). */
const saveTargets = new Map();

/** File name without characters Windows refuses; always ends in .pdf. */
function safePdfName(name) {
  let base = String(name || '').split(/[\\/]/).pop() || '';
  base = base.replace(/[:*?"<>|\u0000-\u001f]+/g, '_').replace(/[. ]+$/, '').trim();
  if (!base) base = 'document-marked.pdf';
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

ipcMain.handle('pdf:save-as-choose', async (e, suggestedName) => {
  if (!fromApp(e) || !win) throw new Error('not allowed');
  let dir = lastOpenDir;
  try {
    if (!dir || !fs.statSync(dir).isDirectory()) dir = app.getPath('documents');
  } catch {
    dir = app.getPath('documents');
  }
  const r = await dialog.showSaveDialog(win, {
    title: 'שמור בשם',
    defaultPath: path.join(dir, safePdfName(suggestedName)),
    buttonLabel: 'שמור',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (r.canceled || !r.filePath) return null;
  const file = /\.pdf$/i.test(r.filePath) ? r.filePath : `${r.filePath}.pdf`;
  const token = crypto.randomUUID();
  saveTargets.set(token, file);
  return { token, name: path.basename(file) };
});

ipcMain.handle('pdf:save-as-write', async (e, token, bytes) => {
  if (!fromApp(e)) throw new Error('not allowed');
  const file = saveTargets.get(String(token));
  if (!file) throw new Error('unknown save target');
  saveTargets.delete(String(token));
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!u8.byteLength || u8.byteLength > MAX_PDF_BYTES) throw new Error('bad file size');
  // Write next to the target, then replace it: a failed write never leaves a truncated PDF behind.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, u8);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  lastOpenDir = path.dirname(file);
});

ipcMain.handle('pdf:open-default-apps', async () => {
  if (process.platform !== 'win32') return;
  await shell.openExternal(DEFAULT_APPS_URI);
});

// ---------------------------------------------------------------- test hook

/**
 * Smoke tests: PDF_VIEWER_CAPTURE=<file.png> saves a screenshot of the window
 * PDF_VIEWER_CAPTURE_DELAY_MS (default 8000) after the page loaded, plus
 * <file.png>.json with what the page shows (incl. whether the one-time default-app
 * dialog is open and whether prefs.json exists yet); PDF_VIEWER_CAPTURE_QUIT=1 then quits.
 */
function captureForTest(out) {
  const delay = Number(process.env.PDF_VIEWER_CAPTURE_DELAY_MS) || 8000;
  const w = win;
  if (!w) return;
  w.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const info = await w.webContents.executeJavaScript(`(async () => ({
          url: location.href,
          title: document.title,
          desktop: !!(window.pdfDesktop && window.pdfDesktop.isDesktop),
          version: window.pdfDesktop ? window.pdfDesktop.version : null,
          serviceWorker: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
          openFile: (document.querySelector('[data-testid=viewer-main]') || {}).ariaLabel || null,
          pageLabel: (document.querySelector('[data-testid=menu-page-input]') || {}).value || null,
          defaultAppDialog: !!document.querySelector('[data-testid=default-app-dialog]'),
          defaultAppDialogTitle: (document.querySelector('#default-app-title') || {}).textContent || null,
          defaultPdfPrompt: window.pdfDesktop && window.pdfDesktop.getPref ? await window.pdfDesktop.getPref('defaultPdfPrompt').catch(() => 'error') : null,
          error: (document.querySelector('[role=alert]') || {}).textContent || null,
        }))()`);
        info.windowTitle = w.getTitle();
        info.prefsFileExists = fs.existsSync(prefsFile());
        const img = await w.webContents.capturePage();
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, img.toPNG());
        fs.writeFileSync(`${out}.json`, JSON.stringify(info, null, 2));
        console.log('[desktop] capture', out, JSON.stringify(info));
      } catch (err) {
        console.error('[desktop] capture failed', err);
        process.exitCode = 1;
      }
      if (process.env.PDF_VIEWER_CAPTURE_QUIT === '1') app.quit();
    }, delay);
  });
}

// ---------------------------------------------------------------- lifecycle

Menu.setApplicationMenu(null);
nativeTheme.themeSource = 'dark';

app.whenReady().then(() => {
  initUpdater();
  registerProtocol();
  createWindow();
  scheduleUpdateChecks();
  if (process.env.PDF_VIEWER_CAPTURE) captureForTest(process.env.PDF_VIEWER_CAPTURE);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
