/**
 * Workspace file actions + per-file loading progress.
 *
 * App registers the real `addFiles` / `removeDoc` implementations on mount
 * (they need its open flow); UI anywhere (thumbnail drawer, menus) calls them
 * through this store and renders `items` as progress.
 */
import { create } from 'zustand';

export interface QueuedFile {
  key: number;
  name: string;
  size: number;
  status: 'waiting' | 'loading' | 'error';
  error?: string;
}

export interface FileQueueState {
  items: QueuedFile[];
  /** Adds PDFs to the workspace in order (opens the first one when nothing is open). */
  addFiles(files: File[]): void;
  /** Removes an open file (its measurements go with it; later pages are renumbered). */
  removeDoc(docId: string): void;
  dismiss(key: number): void;
}

export const useFileQueue = create<FileQueueState>((set) => ({
  items: [],
  addFiles: () => {},
  removeDoc: () => {},
  dismiss: (key) => set((s) => ({ items: s.items.filter((i) => i.key !== key) })),
}));
