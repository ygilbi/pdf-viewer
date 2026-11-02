// POST /api/auth/login/options { credentialIds?: string[] } → { ok, options: PublicKeyCredentialRequestOptionsJSON }
// With credentialIds (base64url, ≤ 10 — the passkeys this device remembers creating): allowCredentials = those ids
// with transports ['internal'] and hints ['client-device'], so the browser goes straight to Face ID / Touch ID /
// Windows Hello without the cross-device ("phone or tablet" / QR) chooser. Only ids registered in the store are
// listed; when none of them is, all provided ids are returned anyway (uniform behaviour — login/verify then answers
// unknown_credential). Without credentialIds: discoverable-credential login (empty allowCredentials), same hint.
// The challenge is stored as challenge:{id}; the id travels in the short-lived HttpOnly cookie pv_chal
// (Path=/api/auth, 5 min).
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { authError, challengeCookie, parseCredentialIds, randomId, rpInfo } from '../../../_lib/auth.js';
import { clientIp, configOrError, createRateLimiter, jsonWithCookies, readJsonBody } from '../../../_lib/http.js';
import { CHALLENGE_TTL_SECONDS, getStore } from '../../../_lib/store.js';

const limiter = createRateLimiter(30, 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  if (!limiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '60' });
  const parsed = await readJsonBody(req, 16 * 1024);
  if (parsed.error) return parsed.error;
  const ids = parseCredentialIds((parsed.body as { credentialIds?: unknown } | null)?.credentialIds);
  if (ids === 'invalid') return authError('bad_request');
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);
  const { rpId } = rpInfo(req, config);

  const id = randomId(24);
  let options;
  try {
    let allowIds: string[] = [];
    if (ids) {
      const known = (await Promise.all(ids.map(async (cid) => ((await store.getCred(cid)) ? cid : null)))).filter(
        (cid): cid is string => cid !== null,
      );
      allowIds = known.length ? known : ids;
    }
    options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'required',
      allowCredentials: allowIds.map((cid) => ({ id: cid, transports: ['internal'] })),
      timeout: 120_000,
    });
    options.hints = ['client-device'];
    await store.putChallenge(id, { challenge: options.challenge });
  } catch (err) {
    console.error('[access] login/options store error:', err);
    return authError('store_failed');
  }
  return jsonWithCookies({ ok: true, options }, [challengeCookie(req, id, CHALLENGE_TTL_SECONDS)]);
}
