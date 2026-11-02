// GET /api/deny?t=<approval token> — confirmation page only (safe for email link scanners).
// POST /api/deny?t=<approval token> — performs the action.
import { decisionGet, decisionPost } from './_lib/decision.js';

export function GET(req: Request): Response {
  return decisionGet(req, 'deny');
}

export function POST(req: Request): Promise<Response> {
  return decisionPost(req, 'deny');
}
