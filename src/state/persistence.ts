/**
 * Per-PDF persistence of measurements + calibrations in IndexedDB.
 *
 * Flow (driven by App's open flow):
 *   const fp = fingerprintFile(file);   // start hashing in parallel with open()
 *   ...open succeeds...
 *   detachDocument();                   // flush + stop saving for the old file
 *   setDocument(...);                   // store resets to empty state
 *   await restoreDocument(await fp, file.name); // hydrate, then resume saving
 *
 * Saving never happens for a document until its hydration has completed, so
 * the empty state produced by setDocument can't clobber a stored record.
 * Every IndexedDB failure is caught (console.warn) — the app keeps working.
 */
import { createElement, useEffect } from 'react';
import { create } from 'zustand';
import { useViewer } from './store';
import type { ViewerState } from './store';
import { sanitizeCategories } from '../core/measurementEngine';

const DB_NAME = 'aluminum-app';
const DB_VERSION = 1;
const STORE = 'documents';
const MAX_RECORDS = 50;
const SAVE_DEBOUNCE_MS = 400;
const HASH_CHUNK = 256 * 1024;

export interface PersistedDocument {
  fingerprint: string;
  fileName: string;
  updatedAt: number;
  calibrations: ViewerState['calibrations'];
  measurements: ViewerState['measurements'];
  /** Added later — missing in older records (→ default categories). */
  categories?: ViewerState['categories'];
}

// ---------------------------------------------------------------------------
// Tiny IndexedDB wrapper
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'fingerprint' });
        os.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function getRecord(fingerprint: string): Promise<PersistedDocument | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  return reqToPromise(tx.objectStore(STORE).get(fingerprint) as IDBRequest<PersistedDocument | undefined>);
}

async function putRecord(rec: PersistedDocument): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const os = tx.objectStore(STORE);
  os.put(rec);
  // Prune oldest records beyond MAX_RECORDS in the same transaction.
  const countReq = os.count();
  countReq.onsuccess = () => {
    let excess = countReq.result - MAX_RECORDS;
    if (excess <= 0) return;
    const cur = os.index('updatedAt').openCursor(); // ascending = oldest first
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || excess <= 0) return;
      if ((c.value as PersistedDocument).fingerprint !== rec.fingerprint) {
        c.delete();
        excess--;
      }
      c.continue();
    };
  };
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `${name}|${size}|${lastModified}|sha256(first 256KB + last 256KB)`. Never reads the whole file. */
export async function fingerprintFile(file: File): Promise<string> {
  const base = `${file.name}|${file.size}|${file.lastModified}`;
  try {
    if (!globalThis.crypto?.subtle) return base;
    const head = file.slice(0, Math.min(HASH_CHUNK, file.size));
    const tailStart = Math.max(HASH_CHUNK, file.size - HASH_CHUNK);
    const tail = tailStart < file.size ? file.slice(tailStart, file.size) : null;
    const bytes = await new Blob(tail ? [head, tail] : [head]).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return `${base}|${toHex(digest)}`;
  } catch (err) {
    console.warn('[persistence] hashing failed, using metadata-only fingerprint', err);
    return base;
  }
}

// ---------------------------------------------------------------------------
// Session state (module-level; one document at a time)
// ---------------------------------------------------------------------------

let current: { fingerprint: string; fileName: string; hadRecord: boolean } | null = null;
/** Bumped on every detach so stale in-flight restores abandon themselves. */
let token = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let available = true;

/** False once IndexedDB has failed (e.g. private mode) — saved data can't be relied on. */
export function isPersistenceAvailable() {
  return available;
}

function snapshot(): PersistedDocument | null {
  if (!current) return null;
  const s = useViewer.getState();
  return {
    fingerprint: current.fingerprint,
    fileName: current.fileName,
    updatedAt: Date.now(),
    calibrations: s.calibrations,
    measurements: s.measurements,
    categories: s.categories,
  };
}

// IndexedDB transactions started during pagehide are usually aborted when the
// page unloads, so the unload flush also writes a synchronous localStorage
// journal (one record). restoreDocument() applies it if it is newer.
const JOURNAL_KEY = 'aluminum-app:pending-save';

function writeJournal(rec: PersistedDocument) {
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(rec));
  } catch (err) {
    console.warn('[persistence] journal write failed', err);
  }
}

function takeJournal(fingerprint: string): PersistedDocument | null {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as PersistedDocument;
    if (rec?.fingerprint !== fingerprint) return null;
    localStorage.removeItem(JOURNAL_KEY);
    return rec;
  } catch (err) {
    console.warn('[persistence] journal read failed', err);
    return null;
  }
}

function writeNow(unloading = false) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const rec = snapshot();
  if (!rec || !current) return;
  // Don't create records for files that were never measured.
  if (!current.hadRecord && rec.measurements.length === 0 && Object.keys(rec.calibrations).length === 0) return;
  current.hadRecord = true;
  if (unloading) writeJournal(rec);
  putRecord(rec).catch((err) => {
    available = false;
    console.warn('[persistence] save failed', err);
  });
}

function scheduleSave() {
  if (!current) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
}

/** Flush any pending save for the current document and stop tracking it. Call BEFORE setDocument. */
export function detachDocument() {
  if (saveTimer) writeNow();
  current = null;
  token++;
}

/**
 * Look up the stored record for `fingerprint`, hydrate the store with it and
 * start auto-saving. Returns the number of restored measurements (0 if none).
 */
export async function restoreDocument(fingerprint: string, fileName: string): Promise<number> {
  const my = ++token;
  let rec: PersistedDocument | undefined;
  try {
    rec = await getRecord(fingerprint);
  } catch (err) {
    available = false;
    console.warn('[persistence] lookup failed', err);
  }
  if (my !== token) return 0; // another document was opened meanwhile
  const journal = takeJournal(fingerprint);
  if (journal && (!rec || journal.updatedAt > rec.updatedAt)) {
    rec = journal;
    putRecord({ ...journal, fileName }).catch((err) => console.warn('[persistence] journal replay failed', err));
  }
  current = { fingerprint, fileName, hadRecord: !!rec };
  if (!rec) return 0;
  const s = useViewer.getState();
  const measurements = Array.isArray(rec.measurements) ? rec.measurements : [];
  const calibrations = rec.calibrations && typeof rec.calibrations === 'object' ? rec.calibrations : {};
  // Merge with anything drawn in the brief window before hydration.
  const ids = new Set(s.measurements.map((m) => m.id));
  const categories = sanitizeCategories(rec.categories);
  useViewer.setState({
    measurements: [...measurements.filter((m) => !ids.has(m.id)), ...s.measurements],
    calibrations: { ...calibrations, ...s.calibrations },
    ...(categories ? { categories } : {}),
  });
  const n = measurements.length;
  if (n > 0) useRestoreToast.setState({ count: n, key: Date.now() });
  return n;
}

// ---------------------------------------------------------------------------
// Init hook: store subscription + pagehide flush
// ---------------------------------------------------------------------------

export function usePersistence() {
  useEffect(() => {
    const unsub = useViewer.subscribe((s, prev) => {
      if (
        s.measurements !== prev.measurements ||
        s.calibrations !== prev.calibrations ||
        s.categories !== prev.categories
      )
        scheduleSave();
    });
    const flush = () => {
      if (saveTimer) writeNow(true);
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      unsub();
      flush();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
}

// ---------------------------------------------------------------------------
// "Restored N measurements" toast
// ---------------------------------------------------------------------------

const useRestoreToast = create<{ count: number; key: number }>(() => ({ count: 0, key: 0 }));

export function RestoreToast() {
  const { count, key } = useRestoreToast();
  useEffect(() => {
    if (!count) return;
    const t = setTimeout(() => useRestoreToast.setState({ count: 0 }), 6000);
    return () => clearTimeout(t);
  }, [count, key]);
  if (!count) return null;
  const text = count === 1 ? 'שוחזרה מדידה אחת משמירה קודמת' : `שוחזרו ${count} מדידות משמירה קודמת`;
  return createElement(
    'div',
    {
      role: 'status',
      'data-testid': 'restore-toast',
      className:
        'pointer-events-auto absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-md border border-emerald-700 bg-emerald-950/90 px-4 py-2 text-sm text-emerald-100 shadow-lg',
    },
    createElement('span', null, text),
    createElement(
      'button',
      {
        type: 'button',
        'aria-label': 'סגור הודעה',
        onClick: () => useRestoreToast.setState({ count: 0 }),
        className: 'rounded px-1 text-emerald-300 hover:bg-emerald-900 hover:text-white',
      },
      '×',
    ),
  );
}

// Dev-only handle for e2e tests.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __viewerStore?: typeof useViewer }).__viewerStore = useViewer;
}
