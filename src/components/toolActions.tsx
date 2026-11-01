import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { useViewer } from '../state/store';
import type { ToolId } from '../core/types';
import {
  assignDeductions,
  computeCategorySummaries,
  computeDocumentSummary,
  computeNetAreas,
  computePageSummary,
  isMarkupKind,
  kindOf,
  measurementsToCSV,
  polygonAreaM2,
  polygonPerimeterMeters,
  polylineLengthMeters,
} from '../core/measurementEngine';
import {
  IconAreaM2,
  IconArrow,
  IconCloud,
  IconCount,
  IconDeduct,
  IconHand,
  IconHighlight,
  IconLength,
  IconNote,
  IconPen,
  IconRect,
  IconRuler,
  IconText,
} from './ui/icons';
import { baseName, downloadBlob, isTypingTarget } from './ui/util';

export const DOWNLOAD_HINT = "אם ההורדה חסומה, השתמש ב'העתק טבלה'";

export type ToolGroup = 'measure' | 'markup';

export interface ToolDef {
  id: ToolId;
  /** Full name (tooltip, aria-label). */
  label: string;
  /** Short name shown next to the icon in the palette. */
  short: string;
  shortcut: string;
  icon: ReactElement;
  group: ToolGroup;
  /** Extra tooltip line. */
  hint?: string;
}

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = { measure: 'מדידה', markup: 'סימון והערות' };

export const TOOLS: ToolDef[] = [
  { id: 'pan', label: 'יד / הזזה', short: 'יד / הזזה', shortcut: 'V / H', icon: <IconHand />, group: 'measure', hint: 'גרירת סימון מזיזה אותו' },
  { id: 'calibrate', label: 'כיול קנה מידה', short: 'כיול', shortcut: 'C', icon: <IconRuler />, group: 'measure' },
  { id: 'area', label: 'מדידת שטח חזית', short: 'שטח חזית', shortcut: 'A', icon: <IconAreaM2 />, group: 'measure' },
  { id: 'deduct', label: 'פתח לניכוי', short: 'פתח לניכוי', shortcut: 'D', icon: <IconDeduct />, group: 'measure' },
  { id: 'length', label: 'מדידת אורך', short: 'אורך', shortcut: 'L', icon: <IconLength />, group: 'measure' },
  { id: 'count', label: 'ספירת פריטים', short: 'ספירה', shortcut: 'N', icon: <IconCount />, group: 'measure' },
  { id: 'note', label: 'הערה', short: 'הערה', shortcut: 'K', icon: <IconNote />, group: 'markup', hint: 'לחץ למיקום סיכה והקלד הערה' },
  { id: 'text', label: 'טקסט על השרטוט', short: 'טקסט', shortcut: 'X', icon: <IconText />, group: 'markup' },
  { id: 'rect', label: 'מלבן', short: 'מלבן', shortcut: 'R', icon: <IconRect />, group: 'markup', hint: 'גרור לציור' },
  { id: 'cloud', label: 'ענן תיקון', short: 'ענן תיקון', shortcut: 'U', icon: <IconCloud />, group: 'markup', hint: 'גרור מלבן' },
  { id: 'arrow', label: 'חץ', short: 'חץ', shortcut: 'W', icon: <IconArrow />, group: 'markup', hint: 'גרור מהזנב לראש' },
  { id: 'pen', label: 'עט חופשי', short: 'עט חופשי', shortcut: 'P', icon: <IconPen />, group: 'markup' },
  { id: 'highlight', label: 'מרקר (הדגשה)', short: 'מרקר', shortcut: 'G', icon: <IconHighlight />, group: 'markup', hint: 'גרור מלבן שקוף' },
];

/** e.code → tool (e.code so shortcuts work on a Hebrew keyboard layout too). */
const TOOL_KEYS: Record<string, ToolId> = {
  KeyV: 'pan',
  KeyH: 'pan',
  KeyC: 'calibrate',
  KeyA: 'area',
  KeyD: 'deduct',
  KeyL: 'length',
  KeyN: 'count',
  KeyK: 'note',
  KeyX: 'text',
  KeyR: 'rect',
  KeyU: 'cloud',
  KeyW: 'arrow',
  KeyP: 'pen',
  KeyG: 'highlight',
};

/** Global tool / page shortcuts (always active while a document is open). */
export function useToolShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const s = useViewer.getState();
      if (s.numPages === 0) return;
      const t = TOOL_KEYS[e.code];
      if (t) {
        s.setTool(t);
        e.preventDefault();
        return;
      }
      switch (e.code) {
        case 'PageUp':
          s.setPage(s.currentPage - 1);
          break;
        case 'PageDown':
          s.setPage(s.currentPage + 1);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ---- export ----------------------------------------------------------------

export function exportCSV() {
  const s = useViewer.getState();
  const csv = measurementsToCSV(s.measurements, s.calibrations, s.categories);
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${baseName(s.fileName)}-מדידות.csv`);
}

export function exportJSON() {
  const s = useViewer.getState();
  const assignment = assignDeductions(s.measurements);
  const nets = computeNetAreas(s.measurements, s.calibrations, assignment);
  const data = {
    fileName: s.fileName,
    numPages: s.numPages,
    exportedAt: new Date().toISOString(),
    units: { geometry: 'PDF points (1/72 inch), page viewport at scale 1', area: 'm2', length: 'm' },
    calibrations: s.calibrations,
    categories: s.categories,
    measurements: s.measurements.map((m) => {
      const c = s.calibrations[m.page];
      const kind = kindOf(m);
      if (isMarkupKind(kind)) return { ...m, kind, markup: true };
      const ppm = c?.pixelsPerMeter;
      if (kind === 'length') {
        return { ...m, kind, lengthM: ppm ? polylineLengthMeters(m.points, ppm) : null };
      }
      if (kind === 'count') return { ...m, kind, count: m.points.length };
      const area = ppm ? polygonAreaM2(m.points, ppm) : null;
      return {
        ...m,
        kind,
        /** Signed: deductions are negative. */
        areaM2: area === null ? null : kind === 'deduct' ? -area : area,
        perimeterM: ppm ? polygonPerimeterMeters(m.points, ppm) : null,
        ...(kind === 'area'
          ? { netAreaM2: ppm ? (nets.get(m.id)?.netM2 ?? area) : null }
          : { deductFromId: assignment.get(m.id) ?? null }),
      };
    }),
    summary: {
      document: computeDocumentSummary(s.measurements, s.calibrations),
      categories: computeCategorySummaries(s.measurements, s.calibrations, s.categories),
      pages: Object.fromEntries(
        [...new Set(s.measurements.map((m) => m.page))]
          .sort((a, b) => a - b)
          .map((p) => [p, computePageSummary(s.measurements, s.calibrations, p)]),
      ),
    },
  };
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    `${baseName(s.fileName)}-מדידות.json`,
  );
}

// ---- fullscreen -------------------------------------------------------------

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

export const fullscreenSupported = () => {
  const el = document.documentElement as FsEl;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
};

const fsElement = () => document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null;

export function toggleFullscreen() {
  const d = document as FsDoc;
  try {
    if (fsElement()) {
      void (d.exitFullscreen ?? d.webkitExitFullscreen)?.call(d)?.catch?.(() => {});
    } else {
      const el = document.documentElement as FsEl;
      void (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
    }
  } catch {
    /* denied (e.g. iframe without allowfullscreen) */
  }
}

function subscribeFs(cb: () => void) {
  document.addEventListener('fullscreenchange', cb);
  document.addEventListener('webkitfullscreenchange', cb);
  return () => {
    document.removeEventListener('fullscreenchange', cb);
    document.removeEventListener('webkitfullscreenchange', cb);
  };
}

export function useIsFullscreen(): boolean {
  return useSyncExternalStore(subscribeFs, () => !!fsElement(), () => false);
}
