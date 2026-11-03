/**
 * Client-side Drive download (never proxied through our server: Vercel functions cap responses at 4.5 MB).
 * Metadata → PDF check → `alt=media` streamed with progress → File.
 */

export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

export type DriveErrorCode =
  | 'not_pdf'
  | 'not_found' // missing, or not shared with this app (drive.file only covers files opened with / picked in the app)
  | 'forbidden'
  | 'auth' // token expired / revoked
  | 'token_denied' // the user closed / declined Google's consent popup
  | 'popup_blocked'
  | 'too_large'
  | 'network'
  | 'not_configured'
  | 'failed';

const MESSAGES: Record<DriveErrorCode, string> = {
  not_pdf: 'הקובץ שנבחר ב-Google Drive אינו קובץ PDF',
  not_found: 'הקובץ לא נמצא ב-Google Drive, או שאין לאפליקציה הרשאה אליו. פתח/י אותו שוב מ-Drive דרך "פתיחה באמצעות" או בחר/י אותו ב"פתח מ-Google Drive".',
  forbidden: 'אין הרשאה לקובץ הזה ב-Google Drive. בקש/י גישה מבעל הקובץ או היכנס/י עם החשבון שבו הקובץ נמצא.',
  auth: 'פג תוקף ההרשאה ל-Google Drive. נסה/י שוב.',
  token_denied: 'לא ניתנה הרשאה לגשת לקובץ ב-Google Drive.',
  popup_blocked: 'הדפדפן חסם את חלון ההרשאה של Google. אפשר/י חלונות קופצים לאתר ונסה/י שוב.',
  too_large: 'הקובץ גדול מדי לפתיחה בדפדפן.',
  network: 'אין חיבור ל-Google Drive. בדוק/י את החיבור לאינטרנט ונסה/י שוב.',
  not_configured: 'החיבור ל-Google Drive אינו מוגדר בשרת.',
  failed: 'טעינת הקובץ מ-Google Drive נכשלה.',
};

export class DriveError extends Error {
  constructor(
    readonly code: DriveErrorCode,
    detail?: string,
  ) {
    super(detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code]);
    this.name = 'DriveError';
  }
}

export const driveErrorMessage = (err: unknown): string =>
  err instanceof DriveError ? err.message : MESSAGES[err instanceof TypeError ? 'network' : 'failed'];

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
}

export interface DriveFetchOpts {
  token: string;
  resourceKey?: string;
  /** loaded bytes, total bytes (null when unknown). */
  onProgress?(loaded: number, total: number | null): void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** 2 GB: beyond this the browser would not hold the PDF anyway. */
const MAX_BYTES = 2 * 1024 ** 3;

export const isPdfMeta = (m: { name: string; mimeType: string }) =>
  m.mimeType === 'application/pdf' || (m.mimeType === 'application/octet-stream' && /\.pdf$/i.test(m.name));

function headers(id: string, o: DriveFetchOpts): Headers {
  const h = new Headers({ Authorization: `Bearer ${o.token}` });
  if (o.resourceKey) h.set('X-Goog-Drive-Resource-Keys', `${id}/${o.resourceKey}`);
  return h;
}

async function driveGet(url: string, id: string, o: DriveFetchOpts): Promise<Response> {
  const doFetch = o.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(url, { headers: headers(id, o), signal: o.signal });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    throw new DriveError('network');
  }
  if (res.ok) return res;
  if (res.status === 401) throw new DriveError('auth');
  if (res.status === 404) throw new DriveError('not_found');
  if (res.status === 403) {
    // 403 is also used for rate limits ("userRateLimitExceeded") — those are worth a retry, not a permission message.
    let reason = '';
    try {
      const body = (await res.json()) as { error?: { errors?: { reason?: string }[] } };
      reason = body.error?.errors?.[0]?.reason ?? '';
    } catch {
      /* not JSON */
    }
    if (/rateLimit/i.test(reason)) throw new DriveError('failed', 'Google Drive rate limit');
    throw new DriveError('forbidden');
  }
  throw new DriveError('failed', `HTTP ${res.status}`);
}

export async function fetchDriveMeta(id: string, o: DriveFetchOpts): Promise<DriveFileMeta> {
  const res = await driveGet(`${DRIVE_FILES_URL}/${encodeURIComponent(id)}?fields=id,name,mimeType,size,resourceKey&supportsAllDrives=true`, id, o);
  let m: { id?: unknown; name?: unknown; mimeType?: unknown; size?: unknown };
  try {
    m = (await res.json()) as typeof m;
  } catch {
    throw new DriveError('failed', 'bad metadata');
  }
  const size = m.size != null && Number.isFinite(Number(m.size)) ? Number(m.size) : null;
  return {
    id: typeof m.id === 'string' ? m.id : id,
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : `${id}.pdf`,
    mimeType: typeof m.mimeType === 'string' ? m.mimeType : '',
    size,
  };
}

/** Download a Drive PDF as a File (rejects non-PDFs before downloading their content). */
export async function fetchDriveFile(id: string, o: DriveFetchOpts): Promise<File> {
  const meta = await fetchDriveMeta(id, o);
  if (!isPdfMeta(meta)) throw new DriveError('not_pdf', meta.name);
  if (meta.size != null && meta.size > MAX_BYTES) throw new DriveError('too_large');
  const res = await driveGet(`${DRIVE_FILES_URL}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, id, o);
  const lenHeader = Number(res.headers.get('content-length'));
  const total = meta.size ?? (Number.isFinite(lenHeader) && lenHeader > 0 ? lenHeader : null);
  o.onProgress?.(0, total);
  const chunks: BlobPart[] = [];
  let loaded = 0;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        loaded += value.byteLength;
        if (loaded > MAX_BYTES) {
          void reader.cancel();
          throw new DriveError('too_large');
        }
        o.onProgress?.(loaded, total);
      }
    } else {
      const buf = await res.arrayBuffer();
      chunks.push(buf);
      loaded = buf.byteLength;
      o.onProgress?.(loaded, total);
    }
  } catch (err) {
    if (err instanceof DriveError || (err as { name?: string })?.name === 'AbortError') throw err;
    throw new DriveError('network');
  }
  const name = /\.pdf$/i.test(meta.name) ? meta.name : `${meta.name}.pdf`;
  // lastModified 0: a stable fingerprint key, so measurements saved for this file restore on the next open.
  return new File(chunks, name, { type: 'application/pdf', lastModified: 0 });
}
