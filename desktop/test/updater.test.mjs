// Unit tests for desktop/updater.cjs (runs under the root vitest; plain Node, no Electron).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createUpdater, compareVersions, isCheckDue, validateManifest, CHECK_INTERVAL_MS } = require('../updater.cjs');

const DAY = 24 * 60 * 60 * 1000;
const BASE = 'https://site.test';
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** A build: { files: {path: text}, builtAt } -> manifest (same shape as src/pwa/appVersion.ts). */
function makeBuild(files, builtAt, minDesktopVersion = '0.3.0') {
  const list = Object.entries(files)
    .map(([p, text]) => ({ path: p, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const buildId = sha(Buffer.from(list.map((f) => `${f.path}\t${f.size}\t${f.sha256}`).join('\n'))).slice(0, 16);
  return { schema: 1, buildId, builtAt, minDesktopVersion, files: list, inline: { 'index.html': files['index.html'] } };
}

function writeBuild(dir, files, manifest) {
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  }
  fs.writeFileSync(path.join(dir, 'app-version.json'), JSON.stringify(manifest));
}

const FILES_A = {
  'index.html': '<html>A</html>',
  'assets/index-AAAAAAAA.js': 'console.log("A")',
  'assets/pdf.worker-WWWWWWWW.mjs': 'worker',
  'icons/icon-192.png': 'png',
};
const FILES_B = { ...FILES_A, 'index.html': '<html>B</html>', 'assets/index-BBBBBBBB.js': 'console.log("B")' };
delete FILES_B['assets/index-AAAAAAAA.js'];
const FILES_C = { ...FILES_B, 'index.html': '<html>C</html>', 'icons/icon-192.png': 'png-C' };

/** Fake site: serves `site.files` + manifest; records requested paths. */
function fakeSite() {
  const site = { files: {}, manifest: null, requests: [], fail: false, corrupt: null };
  site.fetch = async (url) => {
    const u = new URL(url);
    site.requests.push(u.pathname);
    if (site.fail) throw new Error('ENOTFOUND');
    let body;
    if (u.pathname === '/app-version.json') body = site.manifest && JSON.stringify(site.manifest);
    else body = site.files[decodeURIComponent(u.pathname.slice(1))];
    if (body == null) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    if (site.corrupt && u.pathname === `/${site.corrupt}`) body = body.replace(/.$/, '!');
    const buf = Buffer.from(body);
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  site.publish = (files, manifest) => {
    site.files = { ...files };
    delete site.files['index.html']; // login-gated on the real site: only available inline
    site.manifest = manifest;
  };
  return site;
}

let tmp;
let bundled;
let userData;
let clock;
let site;
const A = makeBuild(FILES_A, '2026-10-01T00:00:00.000Z');
const B = makeBuild(FILES_B, '2026-10-10T00:00:00.000Z');
const C = makeBuild(FILES_C, '2026-10-20T00:00:00.000Z');

const make = (extra = {}) =>
  createUpdater({ userDataDir: userData, bundledRoot: bundled, appVersion: '0.3.0', baseUrl: `${BASE}/`, fetch: site.fetch, now: () => clock, ...extra });
const webDirs = () => (fs.existsSync(path.join(userData, 'web')) ? fs.readdirSync(path.join(userData, 'web')).sort() : []);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfv-updater-'));
  bundled = path.join(tmp, 'web-dist');
  userData = path.join(tmp, 'userData');
  writeBuild(bundled, FILES_A, A);
  clock = Date.parse('2026-11-01T00:00:00Z');
  site = fakeSite();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pure helpers', () => {
  it('isCheckDue: weekly rule', () => {
    const now = Date.parse('2026-11-08T00:00:00Z');
    expect(isCheckDue({}, now)).toBe(true);
    expect(isCheckDue({ lastSuccess: now - 6 * DAY }, now)).toBe(false);
    expect(isCheckDue({ lastSuccess: now - 7 * DAY }, now)).toBe(true);
    expect(isCheckDue({ lastSuccess: now + 3 * DAY }, now)).toBe(true); // clock went back
    expect(isCheckDue({ lastSuccess: 'garbage' }, now)).toBe(true);
    expect(CHECK_INTERVAL_MS).toBe(7 * DAY);
  });
  it('compareVersions / validateManifest', () => {
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1);
    expect(validateManifest(A)).toBeNull();
    expect(validateManifest({ ...A, files: [...A.files, { path: '../x', size: 1, sha256: A.files[0].sha256 }] })).toMatch(/bad path/);
    expect(validateManifest({ ...A, files: [...A.files, { path: 'ICONS/icon-192.png', size: 1, sha256: A.files[0].sha256 }] })).toMatch(/duplicate/);
    expect(validateManifest({ ...A, inline: {} })).toMatch(/inline/);
  });
});

describe('createUpdater', () => {
  it('serves the bundled build when nothing was downloaded', () => {
    const u = make();
    expect(u.resolveServeRoot()).toBe(bundled);
    expect(u.status()).toEqual({ active: A.buildId, pending: null, lastCheck: null });
  });

  it('downloads a new build (reusing unchanged files), applies it on demand and on the next launch', async () => {
    site.publish(FILES_B, B);
    const u = make();
    u.resolveServeRoot();
    const r = await u.check();
    expect(r).toEqual({ status: 'downloaded', buildId: B.buildId });
    // only the manifest and the changed asset hit the network (index.html is inline, the rest is copied)
    expect(site.requests).toEqual(['/app-version.json', '/assets/index-BBBBBBBB.js']);
    const dir = path.join(userData, 'web', B.buildId);
    for (const [p, text] of Object.entries(FILES_B)) expect(fs.readFileSync(path.join(dir, p), 'utf8')).toBe(text);
    expect(webDirs()).toEqual([B.buildId]); // no .tmp-* leftovers
    expect(u.status()).toMatchObject({ active: A.buildId, pending: B.buildId, lastCheck: clock });
    expect(u.activeRoot()).toBe(bundled); // still serving the old build until applied

    expect(u.applyPending()).toBe(dir);
    expect(u.status()).toMatchObject({ active: B.buildId, pending: null });
    expect(u.applyPending()).toBeNull();

    // next launch
    expect(make().resolveServeRoot()).toBe(dir);
  });

  it('checks at most once a week unless forced', async () => {
    site.publish(FILES_A, A);
    const u = make();
    u.resolveServeRoot();
    expect(await u.check()).toEqual({ status: 'up-to-date', buildId: A.buildId });
    site.requests.length = 0;
    clock += 6 * DAY;
    expect(u.isDue()).toBe(false);
    expect(await u.check()).toEqual({ status: 'skipped' });
    expect(site.requests).toEqual([]);
    expect((await u.check({ force: true })).status).toBe('up-to-date');
    clock += 7 * DAY;
    expect(u.isDue()).toBe(true);
  });

  it('network failures are silent and keep the check due', async () => {
    site.fail = true;
    const u = make();
    u.resolveServeRoot();
    const r = await u.check();
    expect(r.status).toBe('error');
    expect(u.isDue()).toBe(true);
    expect(u.activeRoot()).toBe(bundled);
    expect(webDirs()).toEqual([]);
  });

  it('rejects a file whose hash does not match and leaves nothing behind', async () => {
    site.publish(FILES_B, B);
    site.corrupt = 'assets/index-BBBBBBBB.js';
    const u = make();
    u.resolveServeRoot();
    const r = await u.check();
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/hash mismatch/);
    expect(webDirs()).toEqual([]);
    expect(u.status().pending).toBeNull();
    expect(make().resolveServeRoot()).toBe(bundled);
  });

  it('rejects an invalid manifest', async () => {
    site.publish(FILES_B, { ...B, files: [...B.files, { path: '../../evil.exe', size: 1, sha256: B.files[0].sha256 }] });
    const u = make();
    u.resolveServeRoot();
    expect((await u.check()).status).toBe('error');
    expect(webDirs()).toEqual([]);
  });

  it('a build that needs a newer shell is not downloaded', async () => {
    const B2 = makeBuild(FILES_B, B.builtAt, '9.0.0');
    site.publish(FILES_B, B2);
    const u = make();
    u.resolveServeRoot();
    expect(await u.check()).toEqual({ status: 'incompatible', buildId: B2.buildId });
    expect(webDirs()).toEqual([]);
  });

  it('keeps the bundled build when the installer is newer than the site', async () => {
    const OLD = makeBuild(FILES_B, '2026-09-01T00:00:00.000Z');
    site.publish(FILES_B, OLD);
    const u = make();
    u.resolveServeRoot();
    expect((await u.check()).status).toBe('up-to-date');
    expect(webDirs()).toEqual([]);
  });

  it('a newer installer wins over an older downloaded build (and the download is cleaned up)', async () => {
    site.publish(FILES_B, B);
    const u = make();
    u.resolveServeRoot();
    await u.check();
    // install a new installer whose bundled build is C (newer than B)
    fs.rmSync(bundled, { recursive: true });
    writeBuild(bundled, FILES_C, C);
    expect(make().resolveServeRoot()).toBe(bundled);
    expect(webDirs()).toEqual([]);
  });

  it('keeps only the build being served and the newest one', async () => {
    site.publish(FILES_B, B);
    let u = make();
    u.resolveServeRoot();
    await u.check();
    u = make(); // restart: serving B
    expect(u.resolveServeRoot()).toBe(path.join(userData, 'web', B.buildId));
    site.publish(FILES_C, C);
    clock += 8 * DAY;
    site.requests.length = 0;
    expect(await u.check()).toEqual({ status: 'downloaded', buildId: C.buildId });
    expect(site.requests).toEqual(['/app-version.json', '/icons/icon-192.png']); // index inline, rest reused from B
    expect(webDirs()).toEqual([B.buildId, C.buildId].sort());
    // a stray temp folder and an old build are removed on the next launch
    fs.mkdirSync(path.join(userData, 'web', '.tmp-dead'), { recursive: true });
    expect(make().resolveServeRoot()).toBe(path.join(userData, 'web', C.buildId));
    expect(webDirs()).toEqual([C.buildId]);
  });

  it('concurrent automatic checks do not run twice', async () => {
    site.publish(FILES_B, B);
    const u = make();
    u.resolveServeRoot();
    const [a, b] = await Promise.all([u.check(), u.check()]);
    expect(a.status).toBe('downloaded');
    expect(b.status).toBe('busy');
  });
});
