/**
 * Drive → workspace: get a drive.file token, download each PDF in the browser (with progress) and hand the
 * Files to the normal open flow (first file opens, the rest are added). UI state lives in `useDrive`.
 */
import { create } from 'zustand';
import { useAuthUser } from '../auth/session';
import { useViewer } from '../state/store';
import { getDriveConfig } from './config';
import { DriveError, driveErrorMessage, fetchDriveFile } from './driveFetch';
import { clearDriveToken, getDriveToken, pickDrivePdfs } from './google';

export interface DriveProgress {
  /** 1-based index of the file being downloaded. */
  current: number;
  count: number;
  name: string | null;
  loaded: number;
  total: number | null;
}

export interface DriveUiState {
  status: 'idle' | 'loading' | 'needs_click' | 'error';
  progress: DriveProgress | null;
  message: string | null;
  /** needs_click / error: continue (runs inside the click, so Google's popup is allowed). */
  retry: (() => void) | null;
  cancel(): void;
}

export const useDrive = create<DriveUiState>((set) => ({
  status: 'idle',
  progress: null,
  message: null,
  retry: null,
  cancel: () => set({ status: 'idle', progress: null, message: null, retry: null }),
}));

export interface DriveOpenRequest {
  ids: string[];
  resourceKeys?: Record<string, string>;
  /** login_hint for Google's consent popup (Drive user id or email). */
  hint?: string | null;
}

export type DeliverFiles = (files: File[]) => void;

/** Overall percentage 0–100 (files already done count fully). */
export function overallPercent(p: DriveProgress | null): number | null {
  if (!p) return null;
  if (p.total == null || p.total <= 0) return p.count > 1 ? Math.round(((p.current - 1) / p.count) * 100) : null;
  const frac = Math.min(1, p.loaded / p.total);
  return Math.round(((p.current - 1 + frac) / p.count) * 100);
}

let running = false;

/** Download `req.ids` from Drive and open them. Never throws: failures end in the `useDrive` error card / error toast. */
export async function openFromDrive(req: DriveOpenRequest, deliver: DeliverFiles, onDone?: () => void): Promise<void> {
  if (running) return;
  running = true;
  const set = useDrive.setState;
  const finish = () => {
    running = false;
    onDone?.();
  };
  const fail = (err: unknown, retry: (() => void) | null) => {
    set({ status: 'error', message: driveErrorMessage(err), progress: null, retry });
    finish();
  };
  const again = () => {
    running = false;
    void openFromDrive(req, deliver, onDone);
  };
  set({ status: 'loading', message: null, retry: null, progress: { current: 1, count: req.ids.length, name: null, loaded: 0, total: null } });

  const cfg = await getDriveConfig();
  if (!cfg) return fail(new DriveError('not_configured'), null);
  const hint = req.hint ?? useAuthUser.getState().user?.email ?? null;

  let token: string;
  try {
    token = await getDriveToken({ clientId: cfg.clientId, hint });
  } catch (err) {
    if (err instanceof DriveError && err.code === 'popup_blocked') {
      // Opened from Drive without a click on our page: ask for one, then retry inside it.
      set({ status: 'needs_click', progress: null, message: null, retry: again });
      running = false;
      return;
    }
    return fail(err, again);
  }

  const files: File[] = [];
  const errors: string[] = [];
  for (let i = 0; i < req.ids.length; i++) {
    const id = req.ids[i];
    const onProgress = (loaded: number, total: number | null) =>
      set((s) => ({ progress: { current: i + 1, count: req.ids.length, name: s.progress?.name ?? null, loaded, total } }));
    set({ progress: { current: i + 1, count: req.ids.length, name: null, loaded: 0, total: null } });
    const attempt = () =>
      fetchDriveFile(id, {
        token,
        resourceKey: req.resourceKeys?.[id],
        onProgress,
      });
    try {
      let file: File;
      try {
        file = await attempt();
      } catch (err) {
        if (!(err instanceof DriveError && err.code === 'auth')) throw err;
        // Expired / revoked token: one fresh token, then retry this file.
        clearDriveToken();
        token = await getDriveToken({ clientId: cfg.clientId, hint });
        file = await attempt();
      }
      files.push(file);
    } catch (err) {
      if (req.ids.length === 1) return fail(err, again);
      errors.push(driveErrorMessage(err));
    }
  }
  set({ status: 'idle', progress: null, message: null, retry: null });
  if (files.length) deliver(files);
  if (errors.length) {
    const msg = files.length ? `חלק מהקבצים לא נטענו מ-Google Drive: ${errors[0]}` : errors[0];
    if (files.length) useViewer.getState().setError(msg);
    else {
      set({ status: 'error', message: msg, progress: null, retry: again });
      return finish();
    }
  }
  finish();
}

/**
 * In-app "open from Google Drive": token (popup, inside the click) → Picker (PDFs, multi-select) → download.
 * Call directly from a click handler.
 */
export async function pickFromDrive(deliver: DeliverFiles): Promise<void> {
  try {
    const cfg = await getDriveConfig();
    if (!cfg?.picker) throw new DriveError('not_configured');
    const token = await getDriveToken({ clientId: cfg.clientId, hint: useAuthUser.getState().user?.email ?? null });
    const docs = await pickDrivePdfs({ token, apiKey: cfg.picker.apiKey, appId: cfg.picker.appId });
    if (!docs.length) return;
    const resourceKeys: Record<string, string> = {};
    for (const d of docs) if (d.resourceKey) resourceKeys[d.id] = d.resourceKey;
    await openFromDrive({ ids: docs.map((d) => d.id), resourceKeys }, deliver);
  } catch (err) {
    useDrive.setState({ status: 'error', message: driveErrorMessage(err), progress: null, retry: null });
  }
}
