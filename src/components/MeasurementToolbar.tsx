import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useViewer } from '../state/store';
import type { ToolId } from '../core/types';
import { viewerCommands, subscribeZoom } from './viewer/commands';
import {
  assignDeductions,
  computeDocumentSummary,
  computeNetAreas,
  computeCategorySummaries,
  computePageSummary,
  kindOf,
  measurementsToCSV,
  polygonAreaM2,
  polygonPerimeterMeters,
  polylineLengthMeters,
} from '../core/measurementEngine';
import { ToolButton, ToolbarDivider } from './ui/ToolButton';
import {
  IconChevronLeft,
  IconChevronRight,
  IconCount,
  IconDeduct,
  IconDownload,
  IconFilePdf,
  IconFit,
  IconFolderOpen,
  IconHand,
  IconLength,
  IconPolygon,
  IconRuler,
  IconZoomIn,
  IconZoomOut,
} from './ui/icons';
import { baseName, downloadBlob, isTypingTarget } from './ui/util';
import { CopyTableButton } from './CopyTableButton';
import { ActiveCategorySelect } from './CategorySelect';

const DOWNLOAD_HINT = "אם ההורדה חסומה, השתמש ב'העתק טבלה'";

interface Props {
  onOpenFile(file: File): void;
}

const TOOLS: { id: ToolId; label: string; shortcut: string; icon: ReactElement }[] = [
  { id: 'pan', label: 'יד / הזזה', shortcut: 'V / H', icon: <IconHand /> },
  { id: 'calibrate', label: 'כיול קנה מידה', shortcut: 'C', icon: <IconRuler /> },
  { id: 'area', label: 'מדידת שטח חזית', shortcut: 'A', icon: <IconPolygon /> },
  { id: 'deduct', label: 'פתח לניכוי', shortcut: 'D', icon: <IconDeduct /> },
  { id: 'length', label: 'מדידת אורך', shortcut: 'L', icon: <IconLength /> },
  { id: 'count', label: 'ספירת פריטים', shortcut: 'N', icon: <IconCount /> },
];

export default function MeasurementToolbar({ onOpenFile }: Props) {
  const fileName = useViewer((s) => s.fileName);
  const numPages = useViewer((s) => s.numPages);
  const currentPage = useViewer((s) => s.currentPage);
  const tool = useViewer((s) => s.tool);
  const setTool = useViewer((s) => s.setTool);
  const setPage = useViewer((s) => s.setPage);
  const calibration = useViewer((s) => s.calibrations[s.currentPage]);
  const measurementCount = useViewer((s) => s.measurements.length);
  const hasDoc = numPages > 0;

  const fileInput = useRef<HTMLInputElement>(null);

  // ---- zoom readout ------------------------------------------------------
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    if (!hasDoc) {
      setZoom(null);
      return;
    }
    try {
      const z = viewerCommands.getZoom();
      if (typeof z === 'number' && Number.isFinite(z)) setZoom(z);
    } catch {
      /* viewer not mounted yet */
    }
    return subscribeZoom((z) => setZoom(z));
  }, [hasDoc, fileName]);

  // ---- page input ----------------------------------------------------------
  // null while not editing → the input simply mirrors currentPage.
  const [pageText, setPageText] = useState<string | null>(null);
  const commitPage = () => {
    if (pageText == null) return;
    const n = parseInt(pageText, 10);
    if (Number.isFinite(n)) setPage(n);
    setPageText(null);
  };

  // ---- keyboard shortcuts --------------------------------------------------
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

  // ---- export --------------------------------------------------------------
  const exportCSV = () => {
    const s = useViewer.getState();
    const csv = measurementsToCSV(s.measurements, s.calibrations, s.categories);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${baseName(s.fileName)}-מדידות.csv`);
  };

  const exportJSON = () => {
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
  };

  return (
    <header className="relative z-20 flex h-11 shrink-0 items-center gap-1 border-b border-slate-700 bg-slate-800 px-2 text-slate-200 shadow-md">
      {/* file */}
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onOpenFile(f);
          e.target.value = '';
        }}
      />
      <ToolButton label="פתח קובץ PDF" onClick={() => fileInput.current?.click()} showLabel>
        <IconFolderOpen />
      </ToolButton>
      {fileName && (
        <div
          className="flex max-w-[16rem] items-center gap-1 truncate px-1 text-xs text-slate-400"
          title={fileName}
        >
          <IconFilePdf size={14} className="shrink-0 text-red-400" />
          <span className="truncate" dir="auto">
            {fileName}
          </span>
        </div>
      )}

      <ToolbarDivider />

      {/* tools */}
      <div className="flex items-center gap-0.5 rounded bg-slate-900/60 p-0.5" role="toolbar" aria-label="כלים">
        {TOOLS.map((t) => (
          <ToolButton
            key={t.id}
            label={t.label}
            shortcut={t.shortcut}
            active={hasDoc && tool === t.id}
            disabled={!hasDoc}
            onClick={() => setTool(t.id)}
            showLabel
            // Narrow screens: only the active tool shows its name (tooltips still name every tool).
            labelClassName={hasDoc && tool === t.id ? '' : 'hidden min-[1760px]:inline'}
          >
            {t.icon}
          </ToolButton>
        ))}
      </div>

      <ToolbarDivider />

      {/* zoom */}
      <ToolButton label="הקטן" shortcut="-" disabled={!hasDoc} onClick={() => viewerCommands.zoomOut()}>
        <IconZoomOut />
      </ToolButton>
      <div className="w-12 text-center font-mono text-xs tabular-nums text-slate-300" aria-label="זום">
        {hasDoc && zoom != null ? `${Math.round(zoom)}%` : '—'}
      </div>
      <ToolButton label="הגדל" shortcut="+" disabled={!hasDoc} onClick={() => viewerCommands.zoomIn()}>
        <IconZoomIn />
      </ToolButton>
      <ToolButton label="התאם לדף" shortcut="0 / F" disabled={!hasDoc} onClick={() => viewerCommands.fit()}>
        <IconFit />
      </ToolButton>

      <ToolbarDivider />

      {/* pages */}
      <ToolButton
        label="הדף הקודם"
        shortcut="PageUp"
        disabled={!hasDoc || currentPage <= 1}
        onClick={() => setPage(currentPage - 1)}
      >
        <IconChevronRight />
      </ToolButton>
      <div className="flex items-center gap-1 text-xs text-slate-400">
        <span>דף</span>
        <input
          type="text"
          inputMode="numeric"
          aria-label="מספר דף"
          disabled={!hasDoc}
          value={hasDoc ? (pageText ?? String(currentPage)) : ''}
          onChange={(e) => setPageText(e.target.value.replace(/[^\d]/g, ''))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              commitPage();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setPageText(null);
              requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
            }
          }}
          onBlur={commitPage}
          onFocus={(e) => e.target.select()}
          className="h-6 w-12 rounded border border-slate-600 bg-slate-900 text-center font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none disabled:opacity-40"
        />
        <span className="whitespace-nowrap">מתוך {hasDoc ? numPages : '—'}</span>
      </div>
      <ToolButton
        label="הדף הבא"
        shortcut="PageDown"
        disabled={!hasDoc || currentPage >= numPages}
        onClick={() => setPage(currentPage + 1)}
      >
        <IconChevronLeft />
      </ToolButton>

      <ToolbarDivider />

      {/* calibration status */}
      {hasDoc &&
        (calibration ? (
          <div
            className="flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-emerald-700/70 bg-emerald-900/40 px-2 text-[11px] text-emerald-300"
            title={`כויל לפי ${calibration.meters} מ׳ בדף ${currentPage}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            קנ״מ: 1 מ׳ = {calibration.pixelsPerMeter.toFixed(2)} יח׳
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setTool('calibrate')}
            className="flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-amber-600/70 bg-amber-900/30 px-2 text-[11px] text-amber-300 hover:bg-amber-900/60"
            title="לחץ כדי לכייל את קנה המידה של הדף"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            לא מכויל
          </button>
        ))}

      {hasDoc && (
        <>
          <ToolbarDivider />
          <ActiveCategorySelect />
        </>
      )}

      <div className="flex-1" />

      {/* export */}
      <ToolButton
        label="ייצוא CSV"
        hint={DOWNLOAD_HINT}
        disabled={!hasDoc || measurementCount === 0}
        onClick={exportCSV}
        showLabel
      >
        <IconDownload />
      </ToolButton>
      <ToolButton
        label="ייצוא JSON"
        hint={DOWNLOAD_HINT}
        disabled={!hasDoc || measurementCount === 0}
        onClick={exportJSON}
        showLabel
      >
        <IconDownload />
      </ToolButton>
      <CopyTableButton disabled={!hasDoc || measurementCount === 0} />
    </header>
  );
}
