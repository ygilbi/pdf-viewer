// GET /api/revoke?t=<revoke token> — confirmation page only (safe for email link scanners).
// POST /api/revoke?t=<revoke token> — sets status 'revoked', deletes the user's passkeys and invalidates sessions.
import { decisionGet, decisionPost } from './_lib/decision.js';

export function GET(req: Request): Response {
  return decisionGet(req, 'revoke');
}

export function POST(req: Request): Promise<Response> {
  return decisionPost(req, 'revoke');
}
