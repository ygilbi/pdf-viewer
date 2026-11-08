import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildManifest, compareVersions, isAppFile, isSafeRelPath, validateManifest, MIN_DESKTOP_VERSION } from './appVersion';
import { entryScriptsInBuild } from './updates';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const enc = new TextEncoder();
const file = (path: string, text: string) => ({ path, bytes: enc.encode(text) });

const INPUT = [
  file('index.html', '<!doctype html><script type="module" src="/assets/index-AAAAAAAA.js"></script>'),
  file('assets/index-AAAAAAAA.js', 'console.log(1)'),
  file('assets/pdf.worker-BBBBBBBB.mjs', 'worker'),
  file('icons/icon-192.png', 'png'),
  file('manifest.webmanifest', '{}'),
  file('sw.js', 'sw'),
  file('login.html', 'login'),
  file('download.html', 'dl'),
  file('welcome.html', 'welcome'),
  file('privacy.html', 'privacy'),
  file('tools/fix-pdf-icon.ps1', 'ps'),
  file('assets/index-AAAAAAAA.js.map', '{}'),
  file('app-version.json', '{}'),
];

describe('isAppFile', () => {
  it('keeps the app shell and drops web-only files', () => {
    expect(isAppFile('index.html')).toBe(true);
    expect(isAppFile('assets/x-12345678.js')).toBe(true);
    expect(isAppFile('icons/logo-mark-white@2x.png')).toBe(true);
    expect(isAppFile('demo-facade.pdf')).toBe(true);
    for (const p of ['sw.js', 'login.html', 'download.html', 'welcome.html', 'terms.html', 'tools/a.ps1', 'a.js.map', 'app-version.json']) {
      expect(isAppFile(p), p).toBe(false);
    }
  });
  it('rejects unsafe paths', () => {
    for (const p of ['', '/abs.js', '../x.js', 'a/../b.js', 'a//b.js', './a.js', 'a\\b.js', 'C:/x.js', 'a\0b']) expect(isSafeRelPath(p), p).toBe(false);
  });
});

describe('buildManifest', () => {
  const m = buildManifest({ files: INPUT, builtAt: new Date('2026-11-01T10:00:00Z'), sha256 });

  it('lists exactly the app files, sorted, with sizes and hashes', () => {
    expect(m.files.map((f) => f.path)).toEqual([
      'assets/index-AAAAAAAA.js',
      'assets/pdf.worker-BBBBBBBB.mjs',
      'icons/icon-192.png',
      'index.html',
      'manifest.webmanifest',
    ]);
    const js = m.files[0];
    expect(js.size).toBe(14);
    expect(js.sha256).toBe(sha256(enc.encode('console.log(1)')));
  });

  it('embeds index.html and fills the header', () => {
    expect(m.inline['index.html']).toContain('/assets/index-AAAAAAAA.js');
    expect(m.schema).toBe(1);
    expect(m.builtAt).toBe('2026-11-01T10:00:00.000Z');
    expect(m.minDesktopVersion).toBe(MIN_DESKTOP_VERSION);
    expect(m.buildId).toMatch(/^[0-9a-f]{16}$/);
    expect(validateManifest(m)).toBeNull();
  });

  it('buildId depends on content only (not on time or input order)', () => {
    const again = buildManifest({ files: [...INPUT].reverse(), builtAt: new Date(), sha256 });
    expect(again.buildId).toBe(m.buildId);
    const changed = buildManifest({ files: INPUT.map((f) => (f.path === 'icons/icon-192.png' ? file(f.path, 'png2') : f)), builtAt: new Date(), sha256 });
    expect(changed.buildId).not.toBe(m.buildId);
  });

  it('requires index.html', () => {
    expect(() => buildManifest({ files: INPUT.filter((f) => f.path !== 'index.html'), builtAt: new Date(), sha256 })).toThrow(/index.html/);
  });
});

describe('validateManifest', () => {
  const good = buildManifest({ files: INPUT, builtAt: new Date('2026-11-01T10:00:00Z'), sha256 });
  const clone = () => JSON.parse(JSON.stringify(good));

  it('rejects malformed manifests', () => {
    expect(validateManifest(null)).not.toBeNull();
    const cases: Array<(m: ReturnType<typeof clone>) => void> = [
      (m) => (m.schema = 2),
      (m) => (m.buildId = 'xyz'),
      (m) => (m.builtAt = 'yesterday'),
      (m) => (m.minDesktopVersion = 'one'),
      (m) => (m.files = []),
      (m) => (m.files[0].path = '../evil.js'),
      (m) => (m.files[0].path = 'sw.js'),
      (m) => m.files.push({ ...m.files[0] }),
      (m) => (m.files[0].size = -1),
      (m) => (m.files[0].sha256 = 'abc'),
      (m) => (m.files = m.files.filter((f: { path: string }) => f.path !== 'index.html')),
      (m) => (m.inline = {}),
      (m) => (m.inline['nope.js'] = 'x'),
    ];
    for (const mutate of cases) {
      const m = clone();
      mutate(m);
      expect(validateManifest(m), mutate.toString()).not.toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('compares numerically', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBe(1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(0);
    expect(compareVersions('junk', '0.0.1')).toBe(-1);
  });
});

describe('entryScriptsInBuild', () => {
  const assets = ['https://x.app/assets/index-AAAAAAAA.js', 'https://x.app/assets/b.js'];
  it('same build when every entry script is in the new worker build', () => {
    expect(entryScriptsInBuild(['https://x.app/assets/index-AAAAAAAA.js'], assets)).toBe(true);
    expect(entryScriptsInBuild(['https://x.app/assets/index-AAAAAAAA.js?v=1'], assets)).toBe(true);
  });
  it('different build otherwise; no entries = cannot tell = same', () => {
    expect(entryScriptsInBuild(['https://x.app/assets/index-CCCCCCCC.js'], assets)).toBe(false);
    expect(entryScriptsInBuild([], assets)).toBe(true);
  });
});

describe('service worker precache list', () => {
  it('has no duplicates (Cache.addAll rejects them and the SW never installs)', async () => {
    const { PUBLIC_SHELL } = await import('./swPlugin');
    expect(new Set(PUBLIC_SHELL).size).toBe(PUBLIC_SHELL.length);
  });
});
