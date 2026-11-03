/**
 * Public Google configuration from GET /api/auth/providers:
 *   googleClientId      — OAuth client id (GOOGLE_CLIENT_ID; present when Google sign-in is configured)
 *   googlePickerApiKey  — browser API key for the Picker (GOOGLE_API_KEY, HTTP-referrer restricted)
 *   googleAppId         — Cloud project number (GOOGLE_PROJECT_NUMBER)
 * All three are public by design (they ship to every browser); none is a secret.
 */
import { API_BASE } from '../auth/api';

export interface DriveConfig {
  clientId: string;
  /** null: Picker not configured → no in-app "open from Drive" button (Drive's "Open with" still works). */
  picker: { apiKey: string; appId: string } | null;
}

/** The Windows desktop app (Electron) is not a Drive target: Drive features are web-only. */
export const driveSupported = (): boolean => typeof window !== 'undefined' && !window.pdfDesktop;

export function driveConfigFromProviders(body: unknown): DriveConfig | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const clientId = str(b.googleClientId);
  if (!clientId) return null;
  const apiKey = str(b.googlePickerApiKey);
  const appId = str(b.googleAppId);
  return { clientId, picker: apiKey && appId ? { apiKey, appId } : null };
}

let pending: Promise<DriveConfig | null> | null = null;

/** Cached for the page's lifetime; null when not configured, offline or in the desktop app. Never throws. */
export function getDriveConfig(fetchImpl: typeof fetch = globalThis.fetch?.bind(globalThis)): Promise<DriveConfig | null> {
  if (!driveSupported()) return Promise.resolve(null);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetchImpl(`${API_BASE}auth/providers`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return driveConfigFromProviders(await res.json());
      } catch {
        pending = null; // retry on the next call
        return null;
      }
    })();
  }
  return pending;
}

/** Test hook. */
export function resetDriveConfig(): void {
  pending = null;
}
