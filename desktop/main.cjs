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
 *
 * Auto-update is intentionally not implemented yet (new versions: run the new installer).
 */
'use strict';

const { app, BrowserWindow, Menu, ipcMain, nativeTheme, net, protocol, screen, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const HOST = 'pdf-viewer';
const ORIGIN = `${SCHEME}://${HOST}`;
const PROG_ID = 'PDFViewer.Document';
const DEFAULT_APPS_URI = 'ms-settings:defaultapps?registeredAppUser=PDF%20Viewer';
const BG = '#0f172a';
const WEB_ROOT = path.join(__dirname, 'web-dist');
const ICON = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const MAX_PDF_BYTES = 2 * 1024 * 1024 * 1024; // refuse absurd sizes instead of crashing on readFile

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
    const file = path.normalize(path.join(WEB_ROOT, rel));
    if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
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
    return new URL(u).origin === ORIGIN;
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
ipcMain.handle('pdf:open-default-apps', async () => {
  if (process.platform !== 'win32') return;
  await shell.openExternal(DEFAULT_APPS_URI);
});

// ---------------------------------------------------------------- test hook

/**
 * Smoke tests: PDF_VIEWER_CAPTURE=<file.png> saves a screenshot of the window
 * PDF_VIEWER_CAPTURE_DELAY_MS (default 8000) after the page loaded, plus
 * <file.png>.json with what the page shows; PDF_VIEWER_CAPTURE_QUIT=1 then quits.
 */
function captureForTest(out) {
  const delay = Number(process.env.PDF_VIEWER_CAPTURE_DELAY_MS) || 8000;
  const w = win;
  if (!w) return;
  w.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const info = await w.webContents.executeJavaScript(`({
          url: location.href,
          title: document.title,
          desktop: !!(window.pdfDesktop && window.pdfDesktop.isDesktop),
          version: window.pdfDesktop ? window.pdfDesktop.version : null,
          serviceWorker: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
          openFile: (document.querySelector('[data-testid=viewer-main]') || {}).ariaLabel || null,
          pageLabel: (document.querySelector('[data-testid=pill-page]') || {}).ariaLabel || null,
          defaultAppDialog: !!document.querySelector('[data-testid=default-app-dialog]'),
          error: (document.querySelector('[role=alert]') || {}).textContent || null,
        })`);
        info.windowTitle = w.getTitle();
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
  registerProtocol();
  createWindow();
  if (process.env.PDF_VIEWER_CAPTURE) captureForTest(process.env.PDF_VIEWER_CAPTURE);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
