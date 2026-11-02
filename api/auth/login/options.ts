// POST /api/auth/login/options {} → { ok, options: PublicKeyCredentialRequestOptionsJSON }
// Discoverable-credential login (empty allowCredentials). The challenge is stored as challenge:{id};
// the id travels in the short-lived HttpOnly cookie pv_chal (Path=/api/auth, 5 min).
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { authError, challengeCookie, randomId, rpInfo } from '../../_lib/auth.js';
import { clientIp, configOrError, createRateLimiter, jsonWithCookies } from '../../_lib/http.js';
import { CHALLENGE_TTL_SECONDS, getStore } from '../../_lib/store.js';

const limiter = createRateLimiter(30, 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  if (!limiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '60' });
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const { rpId } = rpInfo(req, config);
  const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'required', allowCredentials: [], timeout: 120_000 });
  const id = randomId(24);
  try {
    await getStore(config.kv).putChallenge(id, { challenge: options.challenge });
  } catch (err) {
    console.error('[access] login/options store error:', err);
    return authError('store_failed');
  }
  return jsonWithCookies({ ok: true, options }, [challengeCookie(req, id, CHALLENGE_TTL_SECONDS)]);
}
