/**
 * Device-local memory of the passkeys created ON THIS DEVICE (browser profile).
 *
 * Why: a sign-in with an empty allowCredentials on a device that has no passkey for this site makes
 * Safari / Chrome fall back to the cross-device chooser ("use a phone or tablet" + QR code) or simply
 * cancel — never Face ID. So /login only offers the biometric button when this device remembers a
 * passkey, and then asks for options restricted to those ids (transport `internal` + hint
 * `client-device`) → straight to Face ID / Touch ID / Windows Hello.
 *
 * Best effort: storage may be blocked (private mode) — every access is wrapped in try/catch.
 */
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

export const DEVICE_KEYS_KEY = 'pdf-viewer:device-passkeys';
export const QUICK_LOGIN_DISMISS_KEY = 'pdf-viewer:quick-login-dismissed';
export const MAX_DEVICE_KEYS = 10;
/** "לא עכשיו" hides the quick sign-in offer on this device for 30 days. */
export const QUICK_LOGIN_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

export interface DeviceKey {
  /** Credential id (base64url), as returned by the server / the WebAuthn response. */
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(s?: Store | null): Store | null {
  if (s !== undefined) return s;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const isKey = (v: unknown): v is DeviceKey => {
  const k = v as Partial<DeviceKey> | null;
  return !!k && typeof k.id === 'string' && k.id.length > 0 && k.id.length <= 1024;
};

/** Newest first; malformed entries are skipped. */
export function loadDeviceKeys(s?: Store | null): DeviceKey[] {
  try {
    const raw = storage(s)?.getItem(DEVICE_KEYS_KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: DeviceKey[] = [];
    for (const v of list) {
      if (!isKey(v) || seen.has(v.id)) continue;
      seen.add(v.id);
      out.push({
        id: v.id,
        email: typeof v.email === 'string' ? v.email : '',
        name: typeof v.name === 'string' ? v.name : '',
        createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
      });
    }
    return out.slice(0, MAX_DEVICE_KEYS);
  } catch {
    return [];
  }
}

function write(list: DeviceKey[], s?: Store | null): DeviceKey[] {
  const kept = list.slice(0, MAX_DEVICE_KEYS);
  try {
    const st = storage(s);
    if (kept.length) st?.setItem(DEVICE_KEYS_KEY, JSON.stringify(kept));
    else st?.removeItem(DEVICE_KEYS_KEY);
  } catch {
    /* private mode / blocked storage */
  }
  return kept;
}

/** Remember (or refresh) a passkey of this device; it moves to the front. Returns the new list. */
export function saveDeviceKey(k: { id: string; email?: string; name?: string; createdAt?: number }, s?: Store | null): DeviceKey[] {
  if (!k.id) return loadDeviceKeys(s);
  const old = loadDeviceKeys(s);
  const prev = old.find((x) => x.id === k.id);
  const entry: DeviceKey = {
    id: k.id,
    email: k.email || prev?.email || '',
    name: k.name || prev?.name || '',
    createdAt: prev?.createdAt ?? k.createdAt ?? Date.now(),
  };
  return write([entry, ...old.filter((x) => x.id !== k.id)], s);
}

export function removeDeviceKey(id: string, s?: Store | null): DeviceKey[] {
  return write(
    loadDeviceKeys(s).filter((x) => x.id !== id),
    s,
  );
}

/** Keep only the ids the server still knows (POST auth/passkey/status). */
export function keepKnownDeviceKeys(known: readonly string[], s?: Store | null): DeviceKey[] {
  const set = new Set(known);
  const list = loadDeviceKeys(s);
  const kept = list.filter((x) => set.has(x.id));
  return kept.length === list.length ? list : write(kept, s);
}

// ---------------------------------------------------------------- "not now"

export function isQuickLoginDismissed(now = Date.now(), s?: Store | null): boolean {
  try {
    const at = Number(storage(s)?.getItem(QUICK_LOGIN_DISMISS_KEY));
    return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < QUICK_LOGIN_DISMISS_MS;
  } catch {
    return false;
  }
}

export function dismissQuickLogin(now = Date.now(), s?: Store | null): void {
  try {
    storage(s)?.setItem(QUICK_LOGIN_DISMISS_KEY, String(now));
  } catch {
    /* ignore */
  }
}

export function clearQuickLoginDismissal(s?: Store | null): void {
  try {
    storage(s)?.removeItem(QUICK_LOGIN_DISMISS_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- option builders

/**
 * Sign-in options for this device's passkeys: allowCredentials = the remembered ids (or the server's
 * list, if it sent one), all with transport `internal` only, plus hint `client-device`. Together they
 * keep the browser on the built-in authenticator (Face ID / Touch ID / Windows Hello) instead of
 * offering "use a phone or tablet" / a QR code. Older backends that ignore `credentialIds` still work:
 * the client builds the list itself (the server verifies whichever credential answers).
 */
export function deviceLoginOptions(
  options: PublicKeyCredentialRequestOptionsJSON,
  credentialIds: readonly string[],
): PublicKeyCredentialRequestOptionsJSON {
  const fromServer = options.allowCredentials?.map((c) => c.id) ?? [];
  const ids = fromServer.length ? fromServer : [...credentialIds];
  return {
    ...options,
    allowCredentials: ids.map((id) => ({ id, type: 'public-key' as const, transports: ['internal' as const] })),
    hints: ['client-device'],
    userVerification: options.userVerification ?? 'required',
  };
}

/** Registration options for a passkey that lives on this device (no phone / security key / QR). */
export function platformRegistrationOptions(options: PublicKeyCredentialCreationOptionsJSON): PublicKeyCredentialCreationOptionsJSON {
  return {
    ...options,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required', ...options.authenticatorSelection, authenticatorAttachment: 'platform' },
    hints: ['client-device'],
  };
}

/** Ids from excludeCredentials (the account's existing passkeys) — one of them is on this device after InvalidStateError. */
export function excludedIds(options: PublicKeyCredentialCreationOptionsJSON): string[] {
  return (options.excludeCredentials ?? []).map((c) => c.id).filter(Boolean);
}
