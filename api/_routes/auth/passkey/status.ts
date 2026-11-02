// POST /api/auth/passkey/status { credentialIds: string[] } → { ok, known: string[] }
// Which of these credential ids (base64url, ≤ 10 — the passkeys this device remembers) are still registered and
// belong to an ACTIVE user. Lets the frontend drop stale local records (revoked access, deleted passkeys) and fall
// back to the email-code sign-in instead of offering a Face ID button that cannot work. No session required.
import { authError, parseCredentialIds } from '../../../_lib/auth.js';
import { clientIp, configOrError, createRateLimiter, jsonResponse, readJsonBody } from '../../../_lib/http.js';
import { getStore } from '../../../_lib/store.js';

const limiter = createRateLimiter(30, 60 * 1000);

export async function POST(req: Request): Promise<Response> {
  if (!limiter.hit(clientIp(req))) return authError('rate_limited', { 'Retry-After': '60' });
  const parsed = await readJsonBody(req, 16 * 1024);
  if (parsed.error) return parsed.error;
  const raw = (parsed.body as { credentialIds?: unknown } | null)?.credentialIds;
  if (!Array.isArray(raw)) return authError('bad_request');
  const ids = parseCredentialIds(raw);
  if (ids === 'invalid') return authError('bad_request');
  const { config, error } = configOrError(['kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);
  try {
    const known = await Promise.all(
      (ids ?? []).map(async (id) => {
        const cred = await store.getCred(id);
        const user = cred ? await store.getUser(cred.userEmail) : null;
        return user?.status === 'active' ? id : null;
      }),
    );
    return jsonResponse({ ok: true, known: known.filter((id): id is string => id !== null) });
  } catch (err) {
    console.error('[access] passkey/status store error:', err);
    return authError('store_failed');
  }
}
