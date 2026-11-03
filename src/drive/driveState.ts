/**
 * Google Drive "Open with" launch: Drive opens the app's Open URL
 * (`/drive/open?state=<url-encoded JSON>`) with
 *   {"ids":["FILE_ID",…],"action":"open","userId":"…","resourceKeys":{"FILE_ID":"KEY"}}
 * or, for "New → PDF Viewer", {"action":"create","folderId":"…","userId":"…"}.
 * https://developers.google.com/drive/api/guides/integrate-open
 */

export const DRIVE_OPEN_PATH = '/drive/open';

/** At most this many files per launch (Drive allows multi-select "Open with"). */
export const MAX_DRIVE_FILES = 20;

export type DriveLaunch =
  | { action: 'open'; ids: string[]; userId: string | null; resourceKeys: Record<string, string> }
  | { action: 'create'; userId: string | null };

/** Drive file ids / resource keys: URL-safe base64-ish tokens. */
const ID_RE = /^[\w-]{1,200}$/;

/** True when the page was opened at Drive's Open URL. */
export function isDriveOpenPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === DRIVE_OPEN_PATH;
}

/**
 * Parse the `state` query parameter (URLSearchParams already URL-decodes it once).
 * Returns null for a missing / malformed state or an unknown action. Invalid ids are dropped.
 */
export function parseDriveState(search: string): DriveLaunch | null {
  const raw = new URLSearchParams(search).get('state');
  if (!raw || raw.length > 16_384) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    // Some clients double-encode the state.
    try {
      v = JSON.parse(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const userId = typeof o.userId === 'string' && ID_RE.test(o.userId) ? o.userId : null;
  if (o.action === 'create') return { action: 'create', userId };
  if (o.action !== 'open') return null;
  const ids = Array.isArray(o.ids)
    ? [...new Set(o.ids.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)))].slice(0, MAX_DRIVE_FILES)
    : [];
  if (!ids.length) return null;
  const resourceKeys: Record<string, string> = {};
  if (o.resourceKeys && typeof o.resourceKeys === 'object' && !Array.isArray(o.resourceKeys)) {
    for (const [id, key] of Object.entries(o.resourceKeys as Record<string, unknown>)) {
      if (ids.includes(id) && typeof key === 'string' && ID_RE.test(key)) resourceKeys[id] = key;
    }
  }
  return { action: 'open', ids, userId, resourceKeys };
}
