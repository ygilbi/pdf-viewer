/**
 * Tiny build-only Vite plugin: emits `sw.js` next to index.html with the list of
 * files to precache (app shell: entry JS/CSS, pdf.js core + workers, icons,
 * manifest) and a version derived from the emitted file names (which contain
 * content hashes). Lazy pdf.js CMap / standard-font chunks are NOT precached;
 * the service worker caches them on demand (cache-first under assets/).
 *
 * Runs in Node (imported from vite.config.ts) — no Node-only imports so it also
 * type-checks under the app tsconfig.
 */
import type { Plugin } from 'vite';
import { SW_SOURCE } from './swTemplate';

/** Module ids of lazily-loaded pdf.js CMaps and standard fonts. */
const LAZY_DATA_RE = /[\\/](cmaps|standard_fonts)[\\/]|\.(bcmap|pfb|ttf)(\?|$)/;

/** Static files from public/ that belong to the app shell. */
const PUBLIC_SHELL = [
  'manifest.webmanifest',
  'icons/favicon.ico',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/logo-wordmark-white.png',
  'icons/file-pdf-32.png',
  'icons/file-pdf-48.png',
  'icons/file-pdf-256.png',
  'icons/file-pdf-512.png',
];

/** FNV-1a 32-bit, hex. Enough to version a cache by file list. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Strip the `-HASH.ext` suffix Vite appends: `assets/Foo-Bar-AbC12_x.js` -> `Foo-Bar`. */
function stem(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  return base.replace(/-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/i, '');
}

export function serviceWorkerPlugin(): Plugin {
  return {
    name: 'aluminum:service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const lazyStems = new Set<string>();
      for (const out of Object.values(bundle)) {
        if (out.type === 'chunk' && !out.isEntry && out.moduleIds.length > 0 && out.moduleIds.every((id) => LAZY_DATA_RE.test(id))) {
          lazyStems.add(out.name);
        }
      }
      const all: string[] = [];
      const precache: string[] = [];
      for (const out of Object.values(bundle)) {
        const f = out.fileName;
        if (f === 'sw.js' || f.endsWith('.map')) continue;
        all.push(f);
        if (f.endsWith('.html')) continue; // index.html is added explicitly below
        const lazy =
          (out.type === 'chunk' && lazyStems.has(out.name)) ||
          // worker sub-builds arrive here as assets; match their lazy chunks by name
          (out.type === 'asset' && lazyStems.has(stem(f))) ||
          /\.(bcmap|pfb|ttf)$/.test(f);
        if (!lazy) precache.push(f);
      }
      all.sort();
      precache.sort();
      const shell = ['index.html', ...PUBLIC_SHELL, ...precache];
      const version = fnv1a(all.join('\n') + '\n' + shell.join('\n'));
      const source = SW_SOURCE.replace('__SW_VERSION__', () => JSON.stringify(version))
        .replace('__SW_PRECACHE__', () => JSON.stringify(shell))
        .replace('__SW_ALL_ASSETS__', () => JSON.stringify(all.filter((f) => f.startsWith('assets/'))));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
