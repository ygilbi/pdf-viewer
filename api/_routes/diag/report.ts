// POST /api/diag/report — on-device crash / diagnostic report from the web app (src/diag/**).
// No auth required (a crash can happen before sign-in), so input is untrusted:
//   - body capped at MAX_REPORT_BYTES (413 above it), JSON re-built through cleanJson() (depth/size limits),
//   - per-IP rate limit in KV (RATE_MAX per hour; 429),
//   - stored in KV as diag:<epoch ms>:<rand> with a 30-day TTL,
//   - owner (OWNER_EMAIL) gets a short summary + the last breadcrumbs, every value HTML-escaped.
// The sender's account email is added when the request carries a valid session cookie.
import { clientIp, configOrError, jsonError, jsonResponse, readJsonBody } from '../../_lib/http.js';
import { getMailer, describeSmtpError } from '../../_lib/mailer.js';
import { getStore } from '../../_lib/store.js';
import { currentUser, randomId } from '../../_lib/auth.js';
import { esc } from '../../_lib/templates.js';

export const MAX_REPORT_BYTES = 200 * 1024;
export const RATE_MAX = 10;
export const RATE_WINDOW_SECONDS = 3600;
export const REPORT_TTL_SECONDS = 30 * 24 * 3600;
export const EMAIL_CRUMBS = 40;

const KINDS = new Set(['crash', 'error', 'manual']);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Rebuild untrusted JSON with limits: depth, keys per object, array length, string length. */
export function cleanJson(v: unknown, depth = 0): Json {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  if (depth >= 6) return null;
  if (Array.isArray(v)) return v.slice(-500).map((x) => cleanJson(x, depth + 1));
  if (typeof v === 'object') {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 60)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k.slice(0, 64)] = cleanJson(x, depth + 1);
    }
    return out;
  }
  return null;
}

interface Crumb {
  t: number;
  k: string;
  d?: Record<string, Json>;
}
interface Session {
  sid?: string;
  role?: string;
  hb?: number;
  clean?: boolean;
  errors?: number;
  lastError?: string;
  state?: Record<string, Json>;
  crumbs: Crumb[];
}
export interface Report {
  v: 1;
  kind: 'crash' | 'error' | 'manual';
  createdAt?: number;
  build?: Record<string, Json>;
  device?: Record<string, Json>;
  sessions: Session[];
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Structural validation; returns an error code or null. */
export function validateReport(body: unknown): string | null {
  if (!isObj(body)) return 'not_object';
  if (body.v !== 1) return 'bad_version';
  if (typeof body.kind !== 'string' || !KINDS.has(body.kind)) return 'bad_kind';
  if (!Array.isArray(body.sessions) || body.sessions.length > 6) return 'bad_sessions';
  for (const s of body.sessions) {
    if (!isObj(s) || !Array.isArray(s.crumbs) || s.crumbs.length > 500) return 'bad_session';
    for (const c of s.crumbs) if (!isObj(c) || typeof c.t !== 'number' || typeof c.k !== 'string') return 'bad_crumb';
  }
  if (body.device !== undefined && !isObj(body.device)) return 'bad_device';
  return null;
}

const str = (v: Json | undefined): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function crumbLine(c: Crumb, ref: number): string {
  const dt = Number.isFinite(ref) ? ((c.t - ref) / 1000).toFixed(1) : String(c.t);
  const d = c.d && isObj(c.d) ? Object.entries(c.d).map(([k, v]) => `${k}=${str(v)}`).join(' ') : '';
  return `${dt}s ${c.k}${d ? ` ${d}` : ''}`.slice(0, 400);
}

/** The most interesting session: the crashed one, else the current one, else the last. */
function mainSession(r: Report): Session | undefined {
  return r.sessions.find((s) => s.role === 'crashed') ?? r.sessions.find((s) => s.role === 'current') ?? r.sessions[r.sessions.length - 1];
}

export function reportEmail(r: Report, id: string, user: string | null): { subject: string; text: string; html: string } {
  const dev = r.device ?? {};
  const s = mainSession(r);
  const ref = typeof s?.hb === 'number' ? s.hb : NaN;
  const crumbs = (s?.crumbs ?? []).slice(-EMAIL_CRUMBS).map((c) => crumbLine(c, ref));
  const ua = str(dev.userAgent).slice(0, 300);
  const shortUa = /iPhone|iPad|Android[^;)]*|Windows NT [\d.]+|Mac OS X [\d_]+/.exec(ua)?.[0] ?? 'unknown device';
  const summary: [string, string][] = [
    ['סוג', r.kind],
    ['מזהה', id],
    ['משתמש', user ?? '(לא מחובר)'],
    ['גרסה', `${str(r.build?.buildId)} ${str(r.build?.asset)}`.trim() || '-'],
    ['מכשיר', ua],
    ['מסך', `${str(dev.screenW)}x${str(dev.screenH)} DPR ${str(dev.dpr)} · viewport ${str(dev.innerW)}x${str(dev.innerH)}`],
    ['זיכרון', `deviceMemory ${str(dev.deviceMemory) || '?'} · cores ${str(dev.cores) || '?'} · platform ${str(dev.platform)}`],
    ['PWA', `standalone ${str(dev.standalone)} · sw ${str(dev.swControlled)}`],
    ['מצב אחרון', str(s?.state as Json)],
    ['שגיאות', `${str(s?.errors ?? 0)}${s?.lastError ? ` · ${str(s.lastError)}` : ''}`],
    ['סשנים', r.sessions.map((x) => `${str(x.role)}:${x.crumbs.length}`).join(', ')],
  ];
  const subject = `[PDF Viewer] דוח תקלה (${r.kind}) — ${shortUa}`;
  const text = [
    ...summary.map(([k, v]) => `${k}: ${v}`),
    '',
    `${crumbs.length} האירועים האחרונים (שניות ביחס לפעימה האחרונה):`,
    ...crumbs,
    '',
    `הדוח המלא שמור ב-KV תחת המפתח ${id} (30 יום).`,
  ].join('\n');
  const rows = summary
    .map(([k, v]) => `<tr><td style="padding:2px 0 2px 12px;color:#5b6470;white-space:nowrap;vertical-align:top">${esc(k)}</td><td dir="ltr" style="padding:2px 0;text-align:left">${esc(v)}</td></tr>`)
    .join('\n');
  const html = `<!doctype html><html lang="he" dir="rtl"><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1d2330">
<h1 style="font-size:18px;margin:0 0 12px">דוח תקלה מהאפליקציה (${esc(r.kind)})</h1>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${rows}</table>
<div style="margin:0 0 6px;font-weight:bold">${crumbs.length} האירועים האחרונים</div>
<pre dir="ltr" style="font-family:Menlo,Consolas,monospace;font-size:12px;background:#f3f5f8;padding:8px;white-space:pre-wrap;text-align:left">${esc(crumbs.join('\n'))}</pre>
<p style="font-size:12px;color:#5b6470">הדוח המלא שמור ב-KV תחת המפתח <code dir="ltr">${esc(id)}</code> (30 יום).</p>
</body></html>`;
  return { subject, text, html };
}

export async function POST(req: Request): Promise<Response> {
  const { config, error } = configOrError(['mail', 'owner', 'kv'], 'json');
  if (error) return error;
  const store = getStore(config.kv);
  const ip = clientIp(req);

  try {
    const n = await store.kv.incr(`diagrl:${ip}`, RATE_WINDOW_SECONDS);
    if (n > RATE_MAX) return jsonError('rate_limited', 'נשלחו יותר מדי דוחות. נסו שוב מאוחר יותר.', 429, {}, { 'Retry-After': String(RATE_WINDOW_SECONDS) });
  } catch (err) {
    console.error('[diag] rate limit store error:', err);
  }

  const parsed = await readJsonBody(req, MAX_REPORT_BYTES);
  if (parsed.error) return parsed.error;
  const invalid = validateReport(parsed.body);
  if (invalid) return jsonError('validation', 'דוח לא תקין.', 400, { reason: invalid });
  const report = cleanJson(parsed.body) as unknown as Report;

  let user: string | null = null;
  try {
    user = (await currentUser(req, config, store))?.email ?? null;
  } catch {
    user = null;
  }

  const id = `diag:${Date.now()}:${randomId(6)}`;
  let stored = false;
  try {
    await store.kv.set(id, JSON.stringify({ receivedAt: new Date().toISOString(), user, report }), REPORT_TTL_SECONDS);
    stored = true;
  } catch (err) {
    console.error('[diag] store error:', err);
  }

  let mailed = false;
  try {
    const m = reportEmail(report, id, user);
    await getMailer(config.mail).send({ to: config.ownerEmail, subject: m.subject, html: m.html, text: m.text });
    mailed = true;
  } catch (err) {
    console.error(`[diag] mail failed: ${describeSmtpError(err)}`);
  }

  console.log(`[diag] report ${id} kind=${report.kind} stored=${stored} mailed=${mailed}`);
  if (!stored && !mailed) return jsonError('store_failed', 'שמירת הדוח נכשלה.', 502);
  return jsonResponse({ ok: true, id, stored, mailed });
}
