/**
 * Per-PDF persistence of measurements + calibrations in IndexedDB.
 *
 * Flow (driven by App's open flow):
 *   const fp = fingerprintFile(file);   // start hashing in parallel with open()
 *   ...open succeeds...
 *   detachDocument();                   // flush + stop saving for the old file(s)
 *   setDocument(...);                   // store resets to empty state
 *   await restoreDocument(await fp, file.name); // hydrate, then resume saving
 * Adding a file to the workspace: addDocument(doc) then
 *   restoreDocument(fp, name, doc.id). Removing: detachDoc(id) then removeDocument(id).
 * Records are per file with LOCAL page numbers (see workspace.ts).
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
import { extractDocData, toGlobalData } from './workspace';

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
// Session state (module-level; one entry per open file of the workspace)
// ---------------------------------------------------------------------------
//
// Each file is saved under its own fingerprint with LOCAL page numbers
// (1..numPages of that file), so a file restores correctly whether it is
// opened alone or at any position in a multi-file workspace. Records written
// before multi-file support were single-file, where local = global.

interface Tracked {
  fingerprint: string;
  fileName: string;
  hadRecord: boolean;
  /** Serialized content of the last write (skip identical re-writes). */
  lastSig: string;
}

/** docId → tracking info. Only docs whose hydration finished are saved. */
const tracked = new Map<string, Tracked>();
/** Bumped by detachDocument() so stale in-flight restores abandon themselves. */
let token = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let available = true;

/** False once IndexedDB has failed (e.g. private mode) — saved data can't be relied on. */
export function isPersistenceAvailable() {
  return available;
}

function snapshot(docId: string, t: Tracked): PersistedDocument | null {
  const s = useViewer.getState();
  const doc = s.docs.find((d) => d.id === docId);
  if (!doc) return null;
  const { measurements, calibrations } = extractDocData(doc, s.measurements, s.calibrations);
  return {
    fingerprint: t.fingerprint,
    fileName: t.fileName,
    updatedAt: Date.now(),
    calibrations,
    measurements,
    categories: s.categories,
  };
}

// IndexedDB transactions started during pagehide are usually aborted when the
// page unloads, so the unload flush also writes a synchronous localStorage
// journal (all files of the workspace). restoreDocument() applies an entry if
// it is newer. Older journals hold a single record object.
const JOURNAL_KEY = 'aluminum-app:pending-save';

function readJournal(): PersistedDocument[] {
  const raw = localStorage.getItem(JOURNAL_KEY);
  if (!raw) return [];
  const v = JSON.parse(raw) as PersistedDocument | PersistedDocument[];
  return (Array.isArray(v) ? v : [v]).filter((r) => r && typeof r.fingerprint === 'string');
}

function writeJournal(recs: PersistedDocument[]) {
  try {
    if (recs.length === 0) return;
    const fps = new Set(recs.map((r) => r.fingerprint));
    let keep: PersistedDocument[] = [];
    try {
      keep = readJournal().filter((r) => !fps.has(r.fingerprint));
    } catch {
      /* corrupt journal → overwrite */
    }
    localStorage.setItem(JOURNAL_KEY, JSON.stringify([...keep, ...recs]));
  } catch (err) {
    console.warn('[persistence] journal write failed', err);
  }
}

function takeJournal(fingerprint: string): PersistedDocument | null {
  try {
    const all = readJournal();
    const rec = all.find((r) => r.fingerprint === fingerprint) ?? null;
    if (!rec) return null;
    const rest = all.filter((r) => r !== rec);
    if (rest.length) localStorage.setItem(JOURNAL_KEY, JSON.stringify(rest));
    else localStorage.removeItem(JOURNAL_KEY);
    return rec;
  } catch (err) {
    console.warn('[persistence] journal read failed', err);
    return null;
  }
}

function signature(rec: PersistedDocument): string {
  return JSON.stringify([rec.measurements, rec.calibrations, rec.categories]);
}

function writeNow(unloading = false) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const journal: PersistedDocument[] = [];
  for (const [docId, t] of tracked) {
    const rec = snapshot(docId, t);
    if (!rec) continue;
    // Don't create records for files that were never measured.
    if (!t.hadRecord && rec.measurements.length === 0 && Object.keys(rec.calibrations).length === 0) continue;
    const sig = signature(rec);
    if (sig === t.lastSig) continue; // unchanged (e.g. another file of the workspace changed)
    t.hadRecord = true;
    t.lastSig = sig;
    journal.push(rec);
    putRecord(rec).catch((err) => {
      available = false;
      t.lastSig = '';
      console.warn('[persistence] save failed', err);
    });
  }
  if (unloading) writeJournal(journal);
}

function scheduleSave() {
  if (tracked.size === 0) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
}

/** Flush any pending save for ALL files and stop tracking them. Call BEFORE setDocument (replace). */
export function detachDocument() {
  if (saveTimer) writeNow();
  tracked.clear();
  token++;
}

/** Flush pending saves and stop tracking one file. Call BEFORE store.removeDocument(docId). */
export function detachDoc(docId: string) {
  if (saveTimer) writeNow();
  tracked.delete(docId);
}

/**
 * Look up the stored record for `fingerprint`, hydrate the store with it
 * (mapped from the file's local pages to its global pages in the workspace)
 * and start auto-saving it. `docId` defaults to the first open file (the
 * single-file flow). Returns the number of restored measurements (0 if none).
 */
export async function restoreDocument(fingerprint: string, fileName: string, docId?: string): Promise<number> {
  const my = token;
  const id = docId ?? useViewer.getState().docs[0]?.id;
  if (id === undefined) return 0;
  let rec: PersistedDocument | undefined;
  try {
    rec = await getRecord(fingerprint);
  } catch (err) {
    available = false;
    console.warn('[persistence] lookup failed', err);
  }
  const s = useViewer.getState();
  const doc = s.docs.find((d) => d.id === id);
  if (my !== token || !doc) return 0; // workspace replaced / file removed meanwhile
  const journal = takeJournal(fingerprint);
  if (journal && (!rec || journal.updatedAt > rec.updatedAt)) {
    rec = journal;
    putRecord({ ...journal, fileName }).catch((err) => console.warn('[persistence] journal replay failed', err));
  }
  tracked.set(id, { fingerprint, fileName, hadRecord: !!rec, lastSig: '' });
  if (!rec) return 0;
  const saved = toGlobalData(
    doc,
    Array.isArray(rec.measurements) ? rec.measurements : [],
    rec.calibrations && typeof rec.calibrations === 'object' ? rec.calibrations : {},
  );
  // Merge with anything drawn in the brief window before hydration.
  const ids = new Set(s.measurements.map((m) => m.id));
  const savedCats = sanitizeCategories(rec.categories);
  let categories: ViewerState['categories'] | undefined;
  if (savedCats) {
    if (s.docs.length <= 1) categories = savedCats; // single file: saved list wins (as before)
    else {
      const have = new Set(s.categories.map((c) => c.id));
      const extra = savedCats.filter((c) => !have.has(c.id));
      if (extra.length) categories = [...s.categories, ...extra];
    }
  }
  useViewer.setState({
    measurements: [...s.measurements, ...saved.measurements.filter((m) => !ids.has(m.id))],
    calibrations: { ...saved.calibrations, ...s.calibrations },
    ...(categories ? { categories } : {}),
  });
  const n = saved.measurements.length;
  if (n > 0) useRestoreToast.setState((t) => ({ count: (Date.now() - t.key < 3000 ? t.count : 0) + n, key: Date.now() }));
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
