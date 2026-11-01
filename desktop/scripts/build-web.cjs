#!/usr/bin/env node
/**
 * Builds the web app (repo root) for the desktop shell into desktop/web-dist/.
 * Relative base (`./`) so every asset URL resolves under app://pdf-viewer/.
 * Uses the root project's own Vite (root `npm ci` must have run); Electron is
 * never installed at the root.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..', '..');
const outDir = path.join(root, 'desktop', 'web-dist');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteBin)) {
  console.error(`[build:web] ${viteBin} not found — run "npm ci" in the repo root first.`);
  process.exit(1);
}

const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
// Same type check as the root `npm run build`.
run([path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-b']);
run([viteBin, 'build', '--base', './', '--outDir', outDir, '--emptyOutDir']);

if (!fs.existsSync(path.join(outDir, 'index.html'))) {
  console.error('[build:web] index.html missing in', outDir);
  process.exit(1);
}
console.log('[build:web] web app built into', path.relative(process.cwd(), outDir) || outDir);
