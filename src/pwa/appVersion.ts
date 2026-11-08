/**
 * App version manifest (`app-version.json`, emitted next to index.html by appVersionPlugin.ts).
 *
 * Consumed by the Windows desktop shell (desktop/updater.cjs): it downloads this file
 * from the deployed site, and when `buildId` differs from the build it serves, fetches
 * every listed file (public /assets/, /icons/, ... paths), verifies size + SHA-256 and
 * switches to the new build. index.html is login-gated on the web, so its text is
 * embedded in `inline` (the manifest itself is a public, dotted path the middleware
 * never gates).
 *
 * Pure helpers only (no Node / DOM APIs): the hash function is injected.
 * Keep `validateManifest` / `compareVersions` in sync with desktop/updater.cjs.
 */

export const APP_VERSION_FILE = 'app-version.json';
export const APP_VERSION_SCHEMA = 1;
/**
 * Oldest desktop shell (desktop/package.json version) that can run this web build.
 * Raise it when the web app starts to depend on a new preload / main-process API.
 */
export const MIN_DESKTOP_VERSION = '0.3.0';

export interface AppVersionFile {
  /** Relative to the app root, forward slashes (e.g. `assets/index-AbC123.js`). */
  path: string;
  size: number;
  /** Lower-case hex SHA-256 of the file bytes. */
  sha256: string;
}

export interface AppVersionManifest {
  schema: typeof APP_VERSION_SCHEMA;
  /** Content hash of the file list (same files => same id, whatever the build time). */
  buildId: string;
  /** ISO time of the build. */
  builtAt: string;
  minDesktopVersion: string;
  files: AppVersionFile[];
  /** Files whose text is embedded (index.html: login-gated on the web). */
  inline: Record<string, string>;
}

export interface BuildInput {
  path: string;
  bytes: Uint8Array;
}

/** HTML pages that are not part of the app shell (separate web-only pages). */
const EXCLUDED_HTML = /\.html$/i;

/**
 * True when an output / public file belongs to the app the desktop shell serves:
 * index.html, assets/**, icons/**, manifest, demo PDF, ... — but never the service
 * worker, source maps, tools/** (PowerShell helper) or the other HTML pages
 * (login / download / welcome / privacy / terms).
 */
export function isAppFile(path: string): boolean {
  if (!isSafeRelPath(path)) return false;
  if (path === 'index.html') return true;
  if (path === 'sw.js' || path === APP_VERSION_FILE) return false;
  if (path.startsWith('tools/')) return false;
  if (path.endsWith('.map')) return false;
  if (EXCLUDED_HTML.test(path)) return false;
  return true;
}

/** Relative POSIX path without `..`, `.`, empty segments, drive letters or backslashes. */
export function isSafeRelPath(path: string): boolean {
  if (typeof path !== 'string' || !path || path.length > 512) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[a-z]:/i.test(path)) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const HEX64 = /^[0-9a-f]{64}$/;
const BUILD_ID = /^[0-9a-f]{16}$/;

const utf8 = new TextEncoder();

/**
 * Builds the manifest from the app's files. Files rejected by `isAppFile` are dropped;
 * index.html is required and is also embedded in `inline`.
 */
export function buildManifest(opts: {
  files: readonly BuildInput[];
  builtAt: Date;
  sha256: (bytes: Uint8Array) => string;
  minDesktopVersion?: string;
}): AppVersionManifest {
  const seen = new Map<string, BuildInput>();
  for (const f of opts.files) if (isAppFile(f.path)) seen.set(f.path, f);
  const index = seen.get('index.html');
  if (!index) throw new Error('app-version: index.html missing from the build');
  const files: AppVersionFile[] = [...seen.values()]
    .map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: opts.sha256(f.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const listing = files.map((f) => `${f.path}\t${f.size}\t${f.sha256}`).join('\n');
  const buildId = opts.sha256(utf8.encode(listing)).slice(0, 16);
  return {
    schema: APP_VERSION_SCHEMA,
    buildId,
    builtAt: opts.builtAt.toISOString(),
    minDesktopVersion: opts.minDesktopVersion ?? MIN_DESKTOP_VERSION,
    files,
    inline: { 'index.html': new TextDecoder().decode(index.bytes) },
  };
}

/** Structural validation of a downloaded manifest (mirrors desktop/updater.cjs). Returns an error string or null. */
export function validateManifest(m: unknown): string | null {
  if (!m || typeof m !== 'object') return 'not an object';
  const v = m as Partial<AppVersionManifest>;
  if (v.schema !== APP_VERSION_SCHEMA) return 'unsupported schema';
  if (typeof v.buildId !== 'string' || !BUILD_ID.test(v.buildId)) return 'bad buildId';
  if (typeof v.builtAt !== 'string' || Number.isNaN(Date.parse(v.builtAt))) return 'bad builtAt';
  if (typeof v.minDesktopVersion !== 'string' || !parseVersion(v.minDesktopVersion)) return 'bad minDesktopVersion';
  if (!Array.isArray(v.files) || v.files.length === 0 || v.files.length > 5000) return 'bad files';
  const paths = new Set<string>();
  for (const f of v.files) {
    if (!f || typeof f !== 'object') return 'bad file entry';
    if (!isAppFile(f.path)) return `bad path: ${String(f.path)}`;
    if (paths.has(f.path)) return `duplicate path: ${f.path}`;
    paths.add(f.path);
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > 200 * 1024 * 1024) return `bad size: ${f.path}`;
    if (typeof f.sha256 !== 'string' || !HEX64.test(f.sha256)) return `bad sha256: ${f.path}`;
  }
  if (!paths.has('index.html')) return 'index.html missing';
  if (!v.inline || typeof v.inline !== 'object') return 'bad inline';
  for (const [p, text] of Object.entries(v.inline)) {
    if (!paths.has(p) || typeof text !== 'string') return `bad inline entry: ${p}`;
  }
  if (typeof v.inline['index.html'] !== 'string') return 'index.html not inline';
  return null;
}

function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1 for numeric major.minor.patch versions; unparsable versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}
