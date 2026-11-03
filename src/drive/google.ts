/**
 * Google Identity Services (OAuth token client) + Google Picker, loaded lazily on first use.
 * Scope drive.file (non-sensitive): access only to files the user opens with the app from Drive or picks in the Picker.
 */
import { DriveError } from './driveFetch';

export const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const GAPI_SRC = 'https://apis.google.com/js/api.js';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// ---------------------------------------------------------------- minimal typings

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: string; hint?: string }): void;
}
interface GoogleOAuth2 {
  initTokenClient(c: {
    client_id: string;
    scope: string;
    hint?: string;
    prompt?: string;
    callback(r: TokenResponse): void;
    error_callback?(e: { type?: string; message?: string }): void;
  }): TokenClient;
}
export interface PickedDoc {
  id: string;
  name?: string;
  mimeType?: string;
  resourceKey?: string;
}
interface GooglePickerNs {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId?: unknown) => { setMimeTypes(m: string): unknown; setIncludeFolders(b: boolean): unknown; setMode?(m: unknown): unknown };
  ViewId: { DOCS: unknown };
  Feature: { MULTISELECT_ENABLED: unknown; SUPPORT_DRIVES?: unknown };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string; NAME: string; MIME_TYPE: string; RESOURCE_KEY?: string };
}
interface PickerBuilder {
  addView(v: unknown): PickerBuilder;
  enableFeature(f: unknown): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setLocale(l: string): PickerBuilder;
  setTitle(t: string): PickerBuilder;
  setOrigin(o: string): PickerBuilder;
  setCallback(cb: (data: Record<string, unknown>) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 }; picker?: GooglePickerNs };
    gapi?: { load(name: string, cb: (() => void) | { callback: () => void; onerror?: () => void }): void };
  }
}

// ---------------------------------------------------------------- script loading

const scripts = new Map<string, Promise<void>>();

export function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scripts.delete(src);
        s.remove();
        reject(new DriveError('network'));
      };
      document.head.appendChild(s);
    });
    scripts.set(src, p);
  }
  return p;
}

// ---------------------------------------------------------------- access token

let cached: { token: string; expiresAt: number; clientId: string } | null = null;

/** Test hook / sign-out. */
export function clearDriveToken(): void {
  cached = null;
}

export interface TokenOpts {
  clientId: string;
  /** login_hint: the Drive user id from the launch state, else the signed-in email. */
  hint?: string | null;
  /** '' = consent only the first time (default); 'consent' forces the screen. */
  prompt?: string;
}

/**
 * OAuth access token for drive.file via the GIS token client (popup). Cached in memory until 1 minute before expiry.
 * Needs a user gesture in most browsers; rejects DriveError('popup_blocked') otherwise.
 */
export async function getDriveToken(o: TokenOpts): Promise<string> {
  if (cached && cached.clientId === o.clientId && cached.expiresAt > Date.now() + 60_000) return cached.token;
  await loadScript(GIS_SRC);
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new DriveError('network', 'Google Identity Services');
  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: o.clientId,
      scope: DRIVE_SCOPE,
      ...(o.hint ? { hint: o.hint } : {}),
      prompt: o.prompt ?? '',
      callback: (r) => {
        if (!r.access_token) {
          reject(new DriveError(r.error === 'access_denied' || !r.error ? 'token_denied' : 'failed', r.error));
          return;
        }
        const ttl = Number(r.expires_in) || 3600;
        cached = { token: r.access_token, expiresAt: Date.now() + ttl * 1000, clientId: o.clientId };
        resolve(r.access_token);
      },
      error_callback: (e) => {
        if (e?.type === 'popup_failed_to_open') reject(new DriveError('popup_blocked'));
        else reject(new DriveError('token_denied'));
      },
    });
    client.requestAccessToken({ prompt: o.prompt ?? '', ...(o.hint ? { hint: o.hint } : {}) });
  });
}

// ---------------------------------------------------------------- picker

export interface PickerOpts {
  token: string;
  apiKey: string;
  /** Cloud project number: grants drive.file access to the picked files. */
  appId: string;
}

/** Load the Picker library (gapi) ahead of the click that opens it. */
export async function loadPicker(): Promise<GooglePickerNs> {
  if (window.google?.picker) return window.google.picker;
  await loadScript(GAPI_SRC);
  await new Promise<void>((resolve, reject) => {
    if (!window.gapi) return reject(new DriveError('network', 'gapi'));
    window.gapi.load('picker', { callback: resolve, onerror: () => reject(new DriveError('network', 'picker')) });
  });
  const ns = window.google?.picker;
  if (!ns) throw new DriveError('network', 'picker');
  return ns;
}

/** Shows the Drive picker (PDFs only, multi-select). Resolves the picked docs, [] when cancelled. */
export async function pickDrivePdfs(o: PickerOpts): Promise<PickedDoc[]> {
  const ns = await loadPicker();
  return new Promise<PickedDoc[]>((resolve) => {
    const view = new ns.DocsView(ns.ViewId.DOCS);
    view.setMimeTypes('application/pdf');
    view.setIncludeFolders(true);
    let builder = new ns.PickerBuilder()
      .addView(view)
      .enableFeature(ns.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(o.token)
      .setDeveloperKey(o.apiKey)
      .setAppId(o.appId)
      .setLocale('iw')
      .setTitle('בחר/י קובצי PDF מ-Google Drive')
      .setOrigin(location.origin);
    if (ns.Feature.SUPPORT_DRIVES) builder = builder.enableFeature(ns.Feature.SUPPORT_DRIVES);
    builder
      .setCallback((data) => {
        const action = data[ns.Response.ACTION];
        if (action === ns.Action.CANCEL) resolve([]);
        if (action !== ns.Action.PICKED) return;
        const docs = (data[ns.Response.DOCUMENTS] as Record<string, unknown>[] | undefined) ?? [];
        resolve(
          docs
            .map((d) => ({
              id: String(d[ns.Document.ID] ?? d.id ?? ''),
              name: typeof d[ns.Document.NAME] === 'string' ? (d[ns.Document.NAME] as string) : undefined,
              mimeType: typeof d[ns.Document.MIME_TYPE] === 'string' ? (d[ns.Document.MIME_TYPE] as string) : undefined,
              resourceKey: typeof d.resourceKey === 'string' ? d.resourceKey : undefined,
            }))
            .filter((d) => d.id),
        );
      })
      .build()
      .setVisible(true);
  });
}
