/**
 * State + actions of the crash-report card (CrashReportCard.tsx) and the ☰ menu's "שלח דוח תקלה".
 */
import { create } from 'zustand';
import { buildAsset, clearPending, deviceInfo, fetchBuildId, flush, getCurrent, getPending, getPrevious, onPendingChange } from './recorder';
import { REPORT_TARGET_BYTES, fitReport, formatCrumb, type DiagReport, type ReportKind, type SessionDump } from './report';

export const REPORT_URL = '/api/diag/report';

type Status = 'ask' | 'sending' | 'sent' | 'failed';

interface DiagUi {
  /** null = card hidden. */
  kind: ReportKind | null;
  status: Status;
  copied: boolean;
  reportId: string | null;
}

export const useDiagUi = create<DiagUi>(() => ({ kind: null, status: 'ask', copied: false, reportId: null }));

/** Show the card when an earlier session crashed (detection may finish a few seconds after load). */
export function watchPending(): () => void {
  const check = () => {
    const p = getPending();
    const ui = useDiagUi.getState();
    if (p && ui.kind === null) useDiagUi.setState({ kind: p.kind, status: 'ask', copied: false, reportId: null });
  };
  check();
  return onPendingChange(check);
}

export async function buildReport(kind: ReportKind): Promise<DiagReport> {
  flush();
  const sessions: SessionDump[] = [];
  const pending = getPending();
  if (pending) sessions.push(pending.session);
  if (kind === 'manual') {
    const prev = getPrevious();
    if (prev && prev.sid !== pending?.session.sid) sessions.push(prev);
  }
  const current = getCurrent();
  if (current) sessions.push(current);
  const report: DiagReport = {
    v: 1,
    kind,
    createdAt: Date.now(),
    build: { buildId: await fetchBuildId(), asset: buildAsset() },
    device: deviceInfo(),
    sessions,
  };
  return fitReport(report, REPORT_TARGET_BYTES);
}

let autoClose: ReturnType<typeof setTimeout> | null = null;

export async function sendReport(): Promise<void> {
  const { kind } = useDiagUi.getState();
  if (!kind) return;
  useDiagUi.setState({ status: 'sending' });
  try {
    const report = await buildReport(kind);
    const res = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      credentials: 'same-origin',
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string };
    if (!res.ok || !body.ok) throw new Error(`HTTP ${res.status}`);
    if (kind !== 'manual') clearPending();
    useDiagUi.setState({ status: 'sent', reportId: body.id ?? null });
    if (autoClose) clearTimeout(autoClose);
    autoClose = setTimeout(() => {
      if (useDiagUi.getState().status === 'sent') useDiagUi.setState({ kind: null });
    }, 6000);
  } catch {
    useDiagUi.setState({ status: 'failed' });
  }
}

/** "לא עכשיו" / close. Dismissing a crash card discards that crash report. */
export function dismissReport(): void {
  const { kind } = useDiagUi.getState();
  if (kind && kind !== 'manual') clearPending();
  useDiagUi.setState({ kind: null, status: 'ask', copied: false });
}

/** ☰ menu "שלח דוח תקלה": sends the current (and previous / crashed) breadcrumbs right away. */
export function sendManualReport(): void {
  useDiagUi.setState({ kind: 'manual', status: 'ask', copied: false, reportId: null });
  void sendReport();
}

/** Plain-text report: a short readable summary followed by the full JSON (to paste into a chat). */
export function reportText(r: DiagReport): string {
  const lines = [`PDF Viewer diagnostic report (${r.kind}) ${new Date(r.createdAt).toISOString()}`, `build: ${r.build.buildId ?? '-'} ${r.build.asset ?? ''}`];
  lines.push(`device: ${r.device.userAgent} | ${r.device.screenW}x${r.device.screenH} @${r.device.dpr} | mem ${r.device.deviceMemory ?? '?'}GB`);
  for (const s of r.sessions) {
    lines.push('', `[${s.role}] ${s.sid} clean=${s.clean} errors=${s.errors} state=${JSON.stringify(s.state)}`);
    for (const c of s.crumbs.slice(-40)) lines.push(`  ${formatCrumb(c, s.hb)}`);
  }
  lines.push('', '--- JSON ---', JSON.stringify(r));
  return lines.join('\n');
}

export async function copyReport(): Promise<boolean> {
  const { kind } = useDiagUi.getState();
  const text = reportText(await buildReport(kind ?? 'manual'));
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Fallback for browsers without async clipboard permission.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
  }
  useDiagUi.setState({ copied: ok });
  return ok;
}
