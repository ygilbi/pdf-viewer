/**
 * Build-only Vite plugin: emits `app-version.json` (see appVersion.ts) listing every
 * file of the app shell with its size and SHA-256 — bundle outputs (index.html,
 * assets/**) plus the files Vite copies from public/ (icons, manifest, demo PDF).
 * The desktop shell (desktop/updater.cjs) uses it to update its web content.
 *
 * Runs in writeBundle and reads the files back from the output directory: chunk code
 * in generateBundle is not final yet (Vite still rewrites preload / import markers).
 *
 * Imported from vite.config.ts only (Node), never from the app.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { APP_VERSION_FILE, buildManifest, isAppFile, type BuildInput } from './appVersion';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function appVersionPlugin(): Plugin {
  let config: ResolvedConfig | null = null;
  return {
    name: 'aluminum:app-version',
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      config = c;
    },
    writeBundle(options, bundle) {
      const outDir = options.dir ?? config?.build.outDir;
      if (!outDir) throw new Error('app-version: unknown output directory');
      const files = new Map<string, BuildInput>();
      // public/ first: bundle outputs win on a (theoretical) name clash, like Vite's own copy.
      const publicDir = config?.publicDir;
      if (publicDir && config?.build.copyPublicDir !== false) {
        let list: string[] = [];
        try {
          list = listFiles(publicDir);
        } catch {
          /* no public dir */
        }
        for (const abs of list) {
          const rel = relative(publicDir, abs).split(sep).join('/');
          if (isAppFile(rel)) files.set(rel, { path: rel, bytes: readFileSync(abs) });
        }
      }
      for (const out of Object.values(bundle)) {
        if (!isAppFile(out.fileName)) continue;
        files.set(out.fileName, { path: out.fileName, bytes: readFileSync(join(outDir, out.fileName)) });
      }
      const manifest = buildManifest({ files: [...files.values()], builtAt: new Date(), sha256 });
      writeFileSync(join(outDir, APP_VERSION_FILE), JSON.stringify(manifest));
    },
  };
}
