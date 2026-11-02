// GET /api/approve?t=<approval token> — confirmation page only (safe for email link scanners).
// POST /api/approve?t=<approval token> — performs the action.
import { decisionGet, decisionPost } from './_lib/decision.js';

export function GET(req: Request): Response {
  return decisionGet(req, 'approve');
}

export function POST(req: Request): Promise<Response> {
  return decisionPost(req, 'approve');
}
