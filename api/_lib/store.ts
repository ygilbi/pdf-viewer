// Persistent state for access control (users, passkeys, invites, WebAuthn challenges).
// Production: Upstash Redis over REST (@upstash/redis). Tests: setStoreForTests(createMemoryStore()).
//
// Keys (all values JSON strings):
//   user:{email}          → UserRecord
//   cred:{credentialId}   → CredentialRecord   (credentialId = base64url, as WebAuthn reports it)
//   usercreds:{email}     → SET of credentialIds
//   invite:{jti}          → { email }  TTL = INVITE_HOURS; deleted when used (single use)
//   userinvites:{email}   → { jtis: string[] } TTL = INVITE_HOURS; outstanding invites of a user (so a
//                           registration that bypasses the link, e.g. Google sign-in, can void them)
//   challenge:{id}        → { challenge, ... } TTL = 5 min; deleted when read (single use)
//   otp:{email}           → OtpRecord          TTL = 10 min; email login code (HMAC hash only, never the code)
//   otpatt:{email}        → counter            TTL = 10 min; atomic count of verify attempts for the current code
//   otpsend:{email}       → { times: number[] } TTL = 1 h;  send timestamps (rate limit for codes per email)
import { Redis } from '@upstash/redis';
import type { KvConfig } from './config.js';

export type UserStatus = 'pending' | 'approved' | 'active' | 'denied' | 'revoked';

export interface UserRecord {
  /** WebAuthn user handle (base64url of 32 random bytes); stable per user. */
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  createdAt: number;
  approvedAt: number | null;
  activatedAt?: number | null;
  revokedAt?: number | null;
  /** Incremented on revoke; sessions carry the epoch they were issued in (see session.ts). */
  sessionEpoch?: number;
  /** When the owner was last emailed an access request for this user (unix seconds). */
  requestedAt?: number | null;
  /** Google account id ("sub") of the last Google sign-in, for reference only. */
  googleSub?: string;
}

export interface CredentialRecord {
  userEmail: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports: string[];
  createdAt: number;
  deviceType?: string;
  backedUp?: boolean;
  lastUsedAt?: number;
}

export interface ChallengeRecord {
  challenge: string;
  /** For registration challenges: the invite jti and email they belong to. */
  jti?: string;
  email?: string;
}

/** Email login code (see api/_lib/otp.ts). */
export interface OtpRecord {
  /** HMAC-SHA256(SIGNING_SECRET, "otp:{email}:{code}"), hex. */
  hash: string;
  /** Expiry, unix seconds. */
  exp: number;
  /** Always 0 when written; the authoritative attempt count is the atomic otpatt:{email} counter
   *  (rewriting this record on each failure could resurrect a code that a parallel request just consumed). */
  attempts: number;
}

/** Raw key/value primitives; both implementations provide exactly these. */
export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Atomically read and delete. */
  getdel(key: string): Promise<string | null>;
  /** Returns the number of keys removed. */
  del(...keys: string[]): Promise<number>;
  sadd(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  /** Atomic increment; sets the TTL when the key is created. Returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  ping(): Promise<void>;
}

export const normEmail = (email: string): string => email.trim().toLowerCase();
export const CHALLENGE_TTL_SECONDS = 5 * 60;

const parse = <T>(raw: string | null): T | null => {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export class Store {
  constructor(readonly kv: Kv) {}

  getUser(email: string): Promise<UserRecord | null> {
    return this.kv.get(`user:${normEmail(email)}`).then(parse<UserRecord>);
  }
  putUser(user: UserRecord): Promise<void> {
    return this.kv.set(`user:${normEmail(user.email)}`, JSON.stringify(user));
  }

  getCred(id: string): Promise<CredentialRecord | null> {
    return this.kv.get(`cred:${id}`).then(parse<CredentialRecord>);
  }
  async putCred(id: string, cred: CredentialRecord): Promise<void> {
    await this.kv.set(`cred:${id}`, JSON.stringify(cred));
    await this.kv.sadd(`usercreds:${normEmail(cred.userEmail)}`, id);
  }
  listCredIds(email: string): Promise<string[]> {
    return this.kv.smembers(`usercreds:${normEmail(email)}`);
  }
  /** Remove every passkey of a user (used on revoke). Returns how many were removed. */
  async deleteUserCreds(email: string): Promise<number> {
    const ids = await this.listCredIds(email);
    if (ids.length) await this.kv.del(...ids.map((id) => `cred:${id}`));
    await this.kv.del(`usercreds:${normEmail(email)}`);
    return ids.length;
  }

  async putInvite(jti: string, email: string, ttlSeconds: number): Promise<void> {
    await this.kv.set(`invite:${jti}`, JSON.stringify({ email: normEmail(email) }), ttlSeconds);
    const key = `userinvites:${normEmail(email)}`;
    const prev = parse<{ jtis?: unknown }>(await this.kv.get(key));
    const jtis = Array.isArray(prev?.jtis) ? prev.jtis.filter((j): j is string => typeof j === 'string') : [];
    await this.kv.set(key, JSON.stringify({ jtis: [...jtis, jti].slice(-20) }), ttlSeconds);
  }
  /** Void every outstanding invite of a user (registration completed another way). Returns how many were removed. */
  async consumeUserInvites(email: string): Promise<number> {
    const key = `userinvites:${normEmail(email)}`;
    const rec = parse<{ jtis?: unknown }>(await this.kv.get(key));
    const jtis = Array.isArray(rec?.jtis) ? rec.jtis.filter((j): j is string => typeof j === 'string') : [];
    const n = jtis.length ? await this.kv.del(...jtis.map((j) => `invite:${j}`)) : 0;
    await this.kv.del(key);
    return n;
  }
  async inviteExists(jti: string): Promise<boolean> {
    return (await this.kv.get(`invite:${jti}`)) != null;
  }
  /** Single-use: true only for the one caller that actually removed the invite. */
  async consumeInvite(jti: string): Promise<boolean> {
    return (await this.kv.del(`invite:${jti}`)) === 1;
  }

  putChallenge(id: string, rec: ChallengeRecord, ttlSeconds = CHALLENGE_TTL_SECONDS): Promise<void> {
    return this.kv.set(`challenge:${id}`, JSON.stringify(rec), ttlSeconds);
  }
  /** Single-use read. */
  takeChallenge(id: string): Promise<ChallengeRecord | null> {
    return this.kv.getdel(`challenge:${id}`).then(parse<ChallengeRecord>);
  }

  getOtp(email: string): Promise<OtpRecord | null> {
    return this.kv.get(`otp:${normEmail(email)}`).then(parse<OtpRecord>);
  }
  /** Overwrites any previous code and resets its attempt counter. */
  async putOtp(email: string, rec: OtpRecord, ttlSeconds: number): Promise<void> {
    await this.kv.del(`otpatt:${normEmail(email)}`);
    await this.kv.set(`otp:${normEmail(email)}`, JSON.stringify(rec), ttlSeconds);
  }
  async deleteOtp(email: string): Promise<void> {
    await this.kv.del(`otp:${normEmail(email)}`, `otpatt:${normEmail(email)}`);
  }
  /** Atomically count one verification attempt for the current code; returns the attempt number. */
  countOtpAttempt(email: string, ttlSeconds: number): Promise<number> {
    return this.kv.incr(`otpatt:${normEmail(email)}`, ttlSeconds);
  }

  async getOtpSends(email: string): Promise<number[]> {
    const rec = parse<{ times?: unknown }>(await this.kv.get(`otpsend:${normEmail(email)}`));
    return Array.isArray(rec?.times) ? rec.times.filter((t): t is number => typeof t === 'number') : [];
  }
  putOtpSends(email: string, times: number[], ttlSeconds: number): Promise<void> {
    return this.kv.set(`otpsend:${normEmail(email)}`, JSON.stringify({ times }), ttlSeconds);
  }

  ping(): Promise<void> {
    return this.kv.ping();
  }
}

// ---------------------------------------------------------------- implementations

export function createUpstashKv(config: KvConfig): Kv {
  // automaticDeserialization off: values stay the exact JSON strings we wrote (middleware reads them raw via REST).
  const redis = new Redis({ url: config.url, token: config.token, automaticDeserialization: false });
  return {
    async get(key) {
      return (await redis.get<string>(key)) ?? null;
    },
    async set(key, value, ttl) {
      if (ttl) await redis.set(key, value, { ex: Math.max(1, Math.round(ttl)) });
      else await redis.set(key, value);
    },
    async getdel(key) {
      return (await redis.getdel<string>(key)) ?? null;
    },
    async del(...keys) {
      return keys.length ? redis.del(...keys) : 0;
    },
    async sadd(key, member) {
      await redis.sadd(key, member);
    },
    async smembers(key) {
      return (await redis.smembers(key)).map(String);
    },
    async incr(key, ttl) {
      const n = Number(await redis.incr(key));
      if (n === 1) await redis.expire(key, Math.max(1, Math.round(ttl)));
      return n;
    },
    async ping() {
      await redis.ping();
    },
  };
}

/** In-memory Kv with TTL support (tests and local experiments only). */
export function createMemoryKv(now: () => number = Date.now): Kv & { dump(): Map<string, unknown> } {
  const data = new Map<string, { v: string | Set<string>; exp: number | null }>();
  const live = (key: string) => {
    const e = data.get(key);
    if (!e) return null;
    if (e.exp !== null && e.exp <= now()) {
      data.delete(key);
      return null;
    }
    return e;
  };
  return {
    async get(key) {
      const e = live(key);
      return e && typeof e.v === 'string' ? e.v : null;
    },
    async set(key, value, ttl) {
      data.set(key, { v: value, exp: ttl ? now() + ttl * 1000 : null });
    },
    async getdel(key) {
      const e = live(key);
      data.delete(key);
      return e && typeof e.v === 'string' ? e.v : null;
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) if (live(k) && data.delete(k)) n++;
      return n;
    },
    async sadd(key, member) {
      const e = live(key);
      if (e && e.v instanceof Set) e.v.add(member);
      else data.set(key, { v: new Set([member]), exp: null });
    },
    async smembers(key) {
      const e = live(key);
      return e && e.v instanceof Set ? [...e.v] : [];
    },
    async incr(key, ttl) {
      const e = live(key);
      const n = (e && typeof e.v === 'string' ? Number(e.v) || 0 : 0) + 1;
      data.set(key, { v: String(n), exp: e ? e.exp : now() + ttl * 1000 });
      return n;
    },
    async ping() {},
    dump() {
      return new Map([...data].map(([k, e]) => [k, e.v]));
    },
  };
}

export function createMemoryStore(now?: () => number): Store {
  return new Store(createMemoryKv(now));
}

let override: Store | null = null;
let cached: { key: string; store: Store } | null = null;

/** Test hook: use the given store (pass null to restore Upstash). */
export function setStoreForTests(store: Store | null): void {
  override = store;
}

export function hasStoreOverride(): boolean {
  return override !== null;
}

export function getStore(config: KvConfig): Store {
  if (override) return override;
  const key = `${config.url}|${config.token}`;
  if (!cached || cached.key !== key) cached = { key, store: new Store(createUpstashKv(config)) };
  return cached.store;
}
