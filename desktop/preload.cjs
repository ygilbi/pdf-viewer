/**
 * Preload (sandboxed, context-isolated): exposes `window.pdfDesktop` to the web app.
 * Contract: src/desktop/bridge.ts (PdfDesktopApi).
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** @type {Set<(files: {name: string, bytes: ArrayBuffer}[]) => void>} */
const listeners = new Set();
let readySent = false;
/** Files that arrived while nobody was subscribed (e.g. between React effect re-runs). */
let held = [];

ipcRenderer.on('pdf:open-files', (_e, files) => {
  const list = (Array.isArray(files) ? files : []).map((f) => {
    const u8 = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    return { name: String(f.name), bytes: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) };
  });
  if (!list.length) return;
  if (!listeners.size) {
    held.push(...list);
    return;
  }
  for (const cb of listeners) {
    try {
      cb(list);
    } catch (err) {
      console.error('[desktop] onOpenFiles listener failed', err);
    }
  }
});

contextBridge.exposeInMainWorld('pdfDesktop', {
  isDesktop: true,
  version: String(ipcRenderer.sendSync('pdf:version') || ''),
  platform: process.platform,
  /** Subscribe to PDFs opened from Explorer / the command line. The first subscription releases queued files. Returns unsubscribe. */
  onOpenFiles(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    if (held.length) {
      const list = held;
      held = [];
      queueMicrotask(() => cb(list));
    }
    if (!readySent) {
      readySent = true;
      ipcRenderer.send('pdf:renderer-ready');
    }
    return () => {
      listeners.delete(cb);
    };
  },
  /** Opens Settings › Apps › Default apps › PDF Viewer (Windows 10/11). */
  openDefaultAppsSettings: () => ipcRenderer.invoke('pdf:open-default-apps'),
  /** true / false from the user's .pdf UserChoice, null when unknown. */
  isDefaultPdfApp: () => ipcRenderer.invoke('pdf:is-default'),
});
