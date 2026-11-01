import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { useViewer } from '../state/store';
import type { ToolId } from '../core/types';
import {
  assignDeductions,
  computeCategorySummaries,
  computeDocumentSummary,
  computeNetAreas,
  computePageSummary,
  kindOf,
  measurementsToCSV,
  polygonAreaM2,
  polygonPerimeterMeters,
  polylineLengthMeters,
} from '../core/measurementEngine';
import { IconCount, IconDeduct, IconHand, IconLength, IconPolygon, IconRuler } from './ui/icons';
import { baseName, downloadBlob, isTypingTarget } from './ui/util';

export const DOWNLOAD_HINT = "אם ההורדה חסומה, השתמש ב'העתק טבלה'";

export const TOOLS: { id: ToolId; label: string; shortcut: string; icon: ReactElement }[] = [
  { id: 'pan', label: 'יד / הזזה', shortcut: 'V / H', icon: <IconHand /> },
  { id: 'calibrate', label: 'כיול קנה מידה', shortcut: 'C', icon: <IconRuler /> },
  { id: 'area', label: 'מדידת שטח חזית', shortcut: 'A', icon: <IconPolygon /> },
  { id: 'deduct', label: 'פתח לניכוי', shortcut: 'D', icon: <IconDeduct /> },
  { id: 'length', label: 'מדידת אורך', shortcut: 'L', icon: <IconLength /> },
  { id: 'count', label: 'ספירת פריטים', shortcut: 'N', icon: <IconCount /> },
];

/** Global tool / page shortcuts (always active while a document is open). */
export function useToolShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const s = useViewer.getState();
      if (s.numPages === 0) return;
      // e.code so shortcuts work on a Hebrew keyboard layout too.
      switch (e.code) {
        case 'KeyV':
        case 'KeyH':
          s.setTool('pan');
          break;
        case 'KeyC':
          s.setTool('calibrate');
          break;
        case 'KeyA':
          s.setTool('area');
          break;
        case 'KeyD':
          s.setTool('deduct');
          break;
        case 'KeyL':
          s.setTool('length');
          break;
        case 'KeyN':
          s.setTool('count');
          break;
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
