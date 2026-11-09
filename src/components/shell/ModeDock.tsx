import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import type { ToolId } from '../../core/types';
import { TOOLS, type ToolDef } from '../toolActions';
import { IconChevronDown, IconEdit } from '../ui/icons';
import { ScaleChip } from '../text/ScaleChip';
import { enterEditMode, loadEditChrome } from './modeActions';
import { HintsToggle } from './HintPanel';

/** Thumbnail drawer width (ThumbnailSidebar is 184px) + gap. */
const THUMBS_OFFSET = 184 + 8;

/** Right edge (px, relative to the viewer region) of the open left drawer; 0 when closed. */
function useLeftDrawerEdge(open: boolean): number {
  const [edge, setEdge] = useState(0);
  useEffect(() => {
    if (!open) {
      setEdge(0);
      return;
    }
    let ro: ResizeObserver | null = null;
    let raf = 0;
    const attach = () => {
      const el = document.querySelector<HTMLElement>('[data-testid="drawer-measurements"]');
      if (!el) {
        raf = requestAnimationFrame(attach);
        return;
      }
      const upd = () => setEdge(el.offsetWidth);
      upd();
      ro = new ResizeObserver(upd);
      ro.observe(el);
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [open]);
  return edge;
}

/**
 * The one bottom zone of the viewer. Everything that wants the bottom of the screen stacks here,
 * top to bottom: "חזור לעמוד N" · "סיום" (count) · the step hint · the dock / edit toolbar.
 * Centred between the open drawers; its height is published as --bottom-slot-h for other
 * floating bits (file-add progress) so they sit above it.
 */
export function BottomSlot({ children, flush, compact }: { children: ReactNode; flush?: boolean; compact: boolean }) {
  const thumbsOpen = useUi((s) => s.thumbsOpen);
  const measOpen = useUi((s) => s.measurementsOpen);
  const editMode = useUi((s) => s.editMode);
  const leftEdge = useLeftDrawerEdge(measOpen && editMode && !compact);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const upd = () => root.style.setProperty('--bottom-slot-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--bottom-slot-h');
    };
  }, []);

  return (
    <div
      ref={ref}
      data-testid="bottom-slot"
      data-viewer-ui
      className="pointer-events-none absolute bottom-0 z-30 flex flex-col items-center gap-2 transition-[left,right] duration-200 ease-out motion-reduce:transition-none"
      style={{
        left: leftEdge,
        right: thumbsOpen && !compact ? THUMBS_OFFSET : 0,
        paddingBottom: flush ? 0 : compact ? 'max(1.25rem, calc(0.5rem + env(safe-area-inset-bottom, 0px)))' : 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {children}
    </div>
  );
}

const dockCls =
  'pointer-events-auto relative flex max-w-[calc(100vw-2.5rem)] flex-col items-stretch gap-1 rounded-2xl border border-slate-600/70 ' +
  'bg-slate-900/90 p-1 text-slate-200 shadow-lg shadow-black/40 backdrop-blur';

/**
 * "✎ מצב עריכה": the only way from the clean view mode into edit mode. One way — edit mode lasts
 * until another file is opened (there is no "סיום עריכה"). Quick checks measured in the view mode are dropped.
 */
export function EditModeToggle({ compact }: { compact: boolean }) {
  return (
    <button
      type="button"
      data-testid="edit-mode-toggle"
      onClick={enterEditMode}
      onPointerEnter={() => void loadEditChrome()}
      onFocus={() => void loadEditChrome()}
      title={'מצב עריכה — כל הכלים (סימון, צורות, ספירה, מסמך, טבלת פריטים…)\nמדידות שנעשו בתצוגה הן בדיקה זמנית ולא נשמרות'}
      className={
        'flex shrink-0 items-center justify-center gap-1.5 rounded-xl border font-semibold transition-colors ' +
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ' +
        (compact ? 'h-12 min-w-[4.5rem] flex-col gap-0.5 px-2 text-[11px] ' : 'h-10 px-3 text-[13px] ') +
        'border-violet-400/70 text-violet-200 hover:bg-violet-900/50 hover:text-white'
      }
    >
      <IconEdit />
      <span className="whitespace-nowrap">מצב עריכה</span>
    </button>
  );
}

function DockButton({
  t,
  label,
  active,
  compact,
  onClick,
  dot,
  testId,
}: {
  t: ToolDef;
  label: string;
  active: boolean;
  compact: boolean;
  onClick(): void;
  dot?: boolean;
  testId: string;
}) {
  const key = t.shortcut.split(' ')[0];
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={t.label}
      aria-pressed={active}
      title={`${t.label}${key ? ` (${key})` : ''}${t.hint ? `\n${t.hint}` : ''}${active ? '\nלחיצה נוספת: יד / הזזה' : ''}`}
      onClick={onClick}
      className={
        'relative flex shrink-0 items-center justify-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ' +
        (compact ? 'h-12 min-w-[3.75rem] flex-col gap-0.5 px-1.5 text-[11px] ' : 'h-10 gap-2 px-3 text-[13px] ') +
        (active ? 'bg-sky-600 text-white shadow-inner' : 'text-slate-200 hover:bg-slate-700/80 hover:text-white')
      }
    >
      <span className="shrink-0">{t.icon}</span>
      <span className="max-w-[6.5rem] truncate whitespace-nowrap">{label}</span>
      {!compact && key && <kbd className="font-mono text-[10px] opacity-50">{key}</kbd>}
      {dot && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-slate-900" aria-hidden="true" />}
    </button>
  );
}

const AREA_KEY = 'aluminum-dock-area-v1';
/** Dock face names of the area-menu tools (the full names stay in tooltips / the variant menu). */
const AREA_FACE: Partial<Record<ToolId, string>> = { rectArea: 'שטח', area: 'שטח מצולע', rectDeduct: 'הפחתה', deduct: 'הפחתת מצולע' };

function loadAreaFace(items: ToolDef[]): ToolId {
  try {
    const v = localStorage.getItem(AREA_KEY) as ToolId | null;
    if (v && items.some((t) => t.id === v)) return v;
  } catch {
    /* ignore */
  }
  return 'rectArea';
}

/** "שטח ▾": the face picks the variant last chosen in ▾ (default: two-corner rectangle); ▾ offers the others. */
function AreaSplit({ compact }: { compact: boolean }) {
  const items = TOOLS.filter((t) => t.menu === 'area');
  const tool = useViewer((s) => s.tool);
  const setTool = useViewer((s) => s.setTool);
  const [face, setFace] = useState<ToolId>(() => loadAreaFace(items));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const remember = (id: ToolId) => {
    setFace(id);
    try {
      localStorage.setItem(AREA_KEY, id);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The face shows the area tool in use (A/B/D/O keys, or polygon after calibrating), else the last one picked in ▾.
  const faceDef = items.find((t) => t.id === tool) ?? items.find((t) => t.id === face) ?? items[0];
  if (!faceDef) return null;
  const active = tool === faceDef.id;
  return (
    <div ref={ref} className="relative flex items-stretch" role="group" aria-label="חישוב שטח">
      <DockButton
        t={faceDef}
        label={AREA_FACE[faceDef.id] ?? faceDef.short}
        active={active}
        compact={compact}
        testId="dock-area"
        onClick={() => setTool(active ? 'pan' : faceDef.id)}
      />
      <button
        type="button"
        data-testid="dock-area-variants"
        aria-label="סוג חישוב שטח: מלבן / מצולע, הוספה / הפחתה"
        aria-expanded={open}
        title="מלבן / מצולע · הוספה / הפחתה"
        onClick={() => setOpen((v) => !v)}
        className={
          'flex w-7 shrink-0 items-center justify-center rounded-xl text-slate-300 hover:bg-slate-700/80 hover:text-white ' +
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ' +
          (open ? 'bg-slate-700/80 text-white' : '')
        }
      >
        <IconChevronDown size={12} className={open ? '' : 'rotate-180'} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="חישוב שטח"
          data-testid="dock-area-menu"
          className="absolute bottom-full right-0 mb-2 flex w-max min-w-[11rem] flex-col gap-0.5 rounded-xl border border-slate-600 bg-slate-900/95 p-1 shadow-xl shadow-black/50 backdrop-blur"
        >
          {items.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={tool === t.id}
              title={t.hint}
              onClick={() => {
                remember(t.id);
                setTool(t.id);
                setOpen(false);
              }}
              className={
                'flex items-center gap-2 rounded-lg px-2 text-[13px] ' +
                (compact ? 'h-11 ' : 'h-9 ') +
                (tool === t.id ? 'bg-sky-600 text-white' : 'text-slate-200 hover:bg-slate-700')
              }
            >
              <span className="shrink-0">{t.icon}</span>
              <span className="flex-1 whitespace-nowrap text-start">{t.label}</span>
              <kbd className="font-mono text-[10px] opacity-50">{t.shortcut.split(' ')[0]}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Scale state of the current page, above the dock buttons: "● לא מכויל" + the detected-scale chip. Nothing once calibrated. */
export function ScaleStatus() {
  const calibrated = useViewer((s) => !!s.calibrations[s.currentPage]);
  const setTool = useViewer((s) => s.setTool);
  if (calibrated) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-1 px-1 pt-0.5" data-testid="dock-scale-status">
      <button
        type="button"
        onClick={() => setTool('calibrate')}
        className="flex h-7 items-center gap-1 whitespace-nowrap rounded-full border border-amber-600/70 bg-amber-900/40 px-2 text-[11px] text-amber-300 hover:bg-amber-900/70"
        title="הדף לא מכויל — לחץ כדי לכייל (C)"
        data-testid="dock-uncalibrated"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        הדף לא מכויל
      </button>
      <ScaleChip placement="above" />
    </div>
  );
}

/** Clean mode: the small window at the bottom — שטח ▾ · מרחק · מצב עריכה (calibrate: the "הדף לא מכויל" chip / C). */
export function CleanDock({ compact }: { compact: boolean }) {
  const tool = useViewer((s) => s.tool);
  const setTool = useViewer((s) => s.setTool);
  const len = TOOLS.find((t) => t.id === 'length');
  return (
    <div className={dockCls} data-testid="mode-dock" data-mode="clean">
      <ScaleStatus />
      <div role="toolbar" aria-label="מדידת שטח ומרחק" className="flex items-stretch justify-center gap-1">
        <AreaSplit compact={compact} />
        {len && (
          <DockButton
            t={len}
            label="מרחק"
            active={tool === 'length'}
            compact={compact}
            testId="dock-length"
            onClick={() => setTool(tool === 'length' ? 'pan' : 'length')}
          />
        )}
        <span className="mx-0.5 w-px shrink-0 self-stretch bg-slate-600/80" aria-hidden="true" />
        <EditModeToggle compact={compact} />
        <HintsToggle />
      </div>
    </div>
  );
}
