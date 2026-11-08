/**
 * Diagnostic report shape + sanitization (pure; shared by the recorder and the report card).
 * Privacy: technical data only — no file contents, no file names (length + extension at most),
 * no measurement text. Every free-text value passes through scrubText().
 */
import type { AliveMarker, DiagState } from './crash';

export type CrumbValue = string | number | boolean | null;
/** One breadcrumb: time (ms epoch), kind, small flat payload. */
export interface Crumb {
  t: number;
  k: string;
  d?: Record<string, CrumbValue>;
}

export interface SessionDump {
  sid: string;
  start: number;
  hb: number;
  clean: boolean;
  endedAt?: number;
  errors: number;
  lastError?: string;
  state: DiagState;
  /** 'current' = the session sending the report. */
  role: 'crashed' | 'previous' | 'current';
  crumbs: Crumb[];
}

export type ReportKind = 'crash' | 'error' | 'manual';

export interface DiagReport {
  v: 1;
  kind: ReportKind;
  createdAt: number;
  build: { buildId?: string; asset?: string };
  device: Record<string, CrumbValue>;
  sessions: SessionDump[];
}

/** Server limit (api/_routes/diag/report.ts); the client aims below it. */
export const REPORT_MAX_BYTES = 200 * 1024;
export const REPORT_TARGET_BYTES = 180 * 1024;
const MAX_TEXT = 300;
const MAX_KEYS = 20;

const FILE_RE = /[^\s/\\"'<>:|*?]+\.(pdf|png|jpe?g|gif|webp|heic|xlsx?|csv|docx?|dwg|dxf|zip|txt)\b/gi;

/** Remove file names, URL query values and long digit runs; truncate. */
export function scrubText(input: unknown, max = MAX_TEXT): string {
  let s = typeof input === 'string' ? input : String(input ?? '');
  s = s
    .replace(FILE_RE, (_m, ext: string) => `<file.${ext.toLowerCase()}>`)
    .replace(/blob:[^\s"')]+/g, 'blob:<url>')
    .replace(/([?&#][\w.-]{1,40}=)[^&\s"')#]+/g, '$1…')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Length + extension of a file name, never the name itself. */
export function fileLabel(name: string | null | undefined): string {
  if (!name) return '';
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return `${name.length}ch${m ? `.${m[1].toLowerCase()}` : ''}`;
}

function cleanValue(v: unknown): CrumbValue | undefined {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  if (typeof v === 'string') return scrubText(v);
  return undefined;
}

export function sanitizeFlat(d: unknown): Record<string, CrumbValue> | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const out: Record<string, CrumbValue> = {};
  let n = 0;
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (n >= MAX_KEYS) break;
    const cv = cleanValue(v);
    if (cv === undefined) continue;
    out[k.slice(0, 32)] = cv;
    n++;
  }
  return out;
}

export function sanitizeCrumb(c: unknown): Crumb | null {
  const x = c as Crumb | null;
  if (!x || typeof x !== 'object' || typeof x.t !== 'number' || !Number.isFinite(x.t) || typeof x.k !== 'string') return null;
  const out: Crumb = { t: Math.round(x.t), k: x.k.slice(0, 32) };
  const d = sanitizeFlat(x.d);
  if (d && Object.keys(d).length) out.d = d;
  return out;
}

export function sessionDump(m: AliveMarker, crumbs: readonly unknown[], role: SessionDump['role']): SessionDump {
  return {
    sid: String(m.sid).slice(0, 40),
    start: m.start,
    hb: m.hb,
    clean: m.clean,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
    errors: m.errors | 0,
    ...(m.lastError ? { lastError: scrubText(m.lastError) } : {}),
    state: (sanitizeFlat(m.state) ?? {}) as DiagState,
    role,
    crumbs: crumbs.map(sanitizeCrumb).filter((c): c is Crumb => !!c),
  };
}

export const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Shrink a report until its JSON fits `maxBytes`: drops the oldest crumbs first, from the
 * least important session ('previous' before 'current' before 'crashed').
 */
export function fitReport(r: DiagReport, maxBytes = REPORT_TARGET_BYTES): DiagReport {
  const out: DiagReport = { ...r, sessions: r.sessions.map((s) => ({ ...s, crumbs: [...s.crumbs] })) };
  const order: SessionDump['role'][] = ['previous', 'current', 'crashed'];
  for (let guard = 0; guard < 200 && byteLength(JSON.stringify(out)) > maxBytes; guard++) {
    const victim = order.map((role) => out.sessions.find((s) => s.role === role && s.crumbs.length > 0)).find(Boolean);
    if (!victim) break;
    victim.crumbs.splice(0, Math.max(1, Math.ceil(victim.crumbs.length * 0.15)));
  }
  return out;
}

/** Human-readable one-liner for a crumb (email / clipboard). */
export function formatCrumb(c: Crumb, ref: number): string {
  const dt = ((c.t - ref) / 1000).toFixed(1);
  const d = c.d ? Object.entries(c.d).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  return `${dt}s ${c.k}${d ? ` ${d}` : ''}`;
}
