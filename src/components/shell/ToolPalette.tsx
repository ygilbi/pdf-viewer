import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { useMarkup } from '../../state/markupStore';
import { ToolButton } from '../ui/ToolButton';
import { IconAreaManual, IconChevronDown, IconCollapse, IconLabels, IconShapes } from '../ui/icons';
import { TOOLS, TOOL_GROUP_LABELS, TOOL_MENU_LABELS, type ToolDef, type ToolGroup, type ToolMenuId } from '../toolActions';
import { STROKE_WIDTHS } from '../../core/markupGeometry';
import { isMarkupKind, kindOf } from '../../core/measurementEngine';

/** Thumbnail drawer width (ThumbnailSidebar is 184px) + gap, so the palette slides clear of it. */
const THUMBS_OFFSET = 184 + 8;
const LABELS_KEY = 'aluminum-palette-labels-v1';
/** Header icon of each expandable menu (when no tool of it is active). */
export const MENU_ICON: Record<ToolMenuId, ReactElement> = { area: <IconAreaManual />, shapes: <IconShapes /> };
/** Each menu sits right after this tool. */
export const MENU_AFTER: Record<string, ToolMenuId> = { calibrate: 'area', text: 'shapes' };

/** Colours offered for markup (null = follow the active category). */
export const MARKUP_SWATCH_NAMES: Record<string, string> = {
  '#111827': 'שחור',
  '#2563eb': 'כחול',
  '#dc2626': 'אדום',
  '#ca8a04': 'חרדל',
  '#9333ea': 'סגול',
  '#16a34a': 'ירוק',
};
/** The six basic line colours offered for markup and drawing. */
export const MARKUP_SWATCHES = Object.keys(MARKUP_SWATCH_NAMES);

function loadLabels(): boolean {
  try {
    const v = localStorage.getItem(LABELS_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

/** Palette sections, in TOOL_GROUP_LABELS order (new groups, e.g. 'document', appear automatically). */
export const TOOL_GROUPS: ToolGroup[] = (Object.keys(TOOL_GROUP_LABELS) as ToolGroup[]).filter((g) => TOOLS.some((t) => t.group === g));
/** Thumbnails handle (top-2 + 36px) + gap: the palette starts below it, top-anchored. */
const PALETTE_TOP = 52;

/**
 * Edit mode, desktop: vertical tool palette on the right (RTL start) edge, anchored to the top
 * so it never covers the sheet's title block in the bottom-right corner. Shows Hebrew labels
 * next to the icons by default, grouped (measure / markup); can switch to
 * icons only (remembered), or collapse to a single button showing the active
 * tool. Scrolls when the window is too short. Keyboard shortcuts work
 * regardless (useToolShortcuts).
 */
export function ToolPalette() {
  const tool = useViewer((s) => s.tool);
  const setTool = useViewer((s) => s.setTool);
  const collapsed = useUi((s) => s.paletteCollapsed);
  const setCollapsed = useUi((s) => s.setPaletteCollapsed);
  const thumbsOpen = useUi((s) => s.thumbsOpen);
  const [labels, setLabelsState] = useState(loadLabels);
  const [styleOpen, setStyleOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<ToolMenuId | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  const active = TOOLS.find((t) => t.id === tool) ?? TOOLS[0];

  const setLabels = (v: boolean) => {
    setLabelsState(v);
    try {
      localStorage.setItem(LABELS_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const btnCls = labels ? 'h-8 w-full justify-start gap-2 px-2' : 'h-9 w-9 justify-center px-0';

  return (
    <div
      data-testid="tool-palette"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-labels={labels ? 'true' : 'false'}
      className={
        'absolute z-20 flex flex-col rounded-xl border border-slate-600/70 ' +
        'bg-slate-900/85 p-1 text-slate-200 shadow-lg shadow-black/40 backdrop-blur ' +
        'transition-[right] duration-200 ease-out motion-reduce:transition-none ' +
        (labels && !collapsed ? 'items-stretch' : 'items-center')
      }
      style={{ right: thumbsOpen ? THUMBS_OFFSET : 8, top: thumbsOpen ? 8 : PALETTE_TOP, maxHeight: `calc(100% - ${PALETTE_TOP + 8}px)` }}
    >
      {collapsed ? (
        <ToolButton
          label={`כלים — ${active.label}`}
          shortcut={active.shortcut}
          active
          tooltipSide="left"
          onClick={() => setCollapsed(false)}
          className="h-9 w-9 justify-center px-0"
        >
          {active.icon}
        </ToolButton>
      ) : (
        <>
          <div
            role="toolbar"
            aria-label="כלים"
            aria-orientation="vertical"
            className={
              'flex min-h-0 flex-col gap-0.5 overflow-y-auto overflow-x-hidden overscroll-contain ' + (labels ? 'w-[10rem]' : 'items-center')
            }
            style={{ scrollbarWidth: 'thin' }}
          >
            {TOOL_GROUPS.map((g, gi) => (
              <Fragment key={g}>
                {labels ? (
                  <div
                    className={`select-none px-2 pb-0.5 text-[10px] font-semibold text-slate-400 ${gi ? 'mt-1.5 border-t border-slate-700 pt-1.5' : 'pt-0.5'}`}
                    data-testid={`tool-group-${g}`}
                  >
                    {TOOL_GROUP_LABELS[g]}
                  </div>
                ) : (
                  gi > 0 && <span className="my-1 h-px w-6 shrink-0 bg-slate-600" aria-hidden="true" />
                )}
                {TOOLS.filter((t) => t.group === g && !t.menu).map((t) => {
                  const m = MENU_AFTER[t.id];
                  return (
                    <Fragment key={t.id}>
                      <PaletteTool t={t} labels={labels} active={tool === t.id} onPick={() => setTool(t.id)} className={btnCls} />
                      {/* Expandable menus ("חישוב שטח" after calibrate, "צורות" after text). */}
                      {m && (
                        <ToolMenu
                          menu={m}
                          labels={labels}
                          open={openMenu === m}
                          onToggle={() => setOpenMenu((o) => (o === m ? null : m))}
                          onClose={closeMenu}
                          tool={tool}
                          onPick={setTool}
                          className={btnCls}
                        />
                      )}
                    </Fragment>
                  );
                })}
                {g === 'markup' && (
                  <StyleButton labels={labels} open={styleOpen} onToggle={() => setStyleOpen((v) => !v)} className={btnCls} />
                )}
              </Fragment>
            ))}
          </div>
          <span className="my-0.5 h-px w-6 shrink-0 self-center bg-slate-700" aria-hidden="true" />
          <div className={labels ? 'flex justify-between' : 'flex flex-col items-center'}>
            <ToolButton
              label={labels ? 'הצג אייקונים בלבד' : 'הצג שמות כלים'}
              tooltipSide="left"
              onClick={() => setLabels(!labels)}
              className="h-6 w-9 justify-center px-0 text-slate-400"
            >
              <IconLabels size={14} />
            </ToolButton>
            <ToolButton
              label="כווץ סרגל כלים"
              tooltipSide="left"
              onClick={() => setCollapsed(true)}
              className="h-6 w-9 justify-center px-0 text-slate-400"
            >
              <IconCollapse size={14} />
            </ToolButton>
          </div>
          {styleOpen && <StylePopover onClose={() => setStyleOpen(false)} />}
        </>
      )}
    </div>
  );
}

function PaletteTool({ t, labels, active, onPick, className, indent }: { t: ToolDef; labels: boolean; active: boolean; onPick(): void; className: string; indent?: boolean }) {
  return (
    <ToolButton
      label={t.label}
      shortcut={t.shortcut}
      hint={t.hint}
      active={active}
      tooltipSide="left"
      onClick={onPick}
      className={className + ' shrink-0' + (indent && labels ? ' ps-4' : '')}
    >
      <span className="shrink-0">{t.icon}</span>
      {labels && (
        <>
          <span className="min-w-0 flex-1 truncate text-start text-[12px]">{t.short}</span>
          <kbd className="shrink-0 font-mono text-[9.5px] text-current opacity-50">{t.shortcut.split(' ')[0]}</kbd>
        </>
      )}
    </ToolButton>
  );
}

/**
 * Tool menu ("חישוב שטח" / "צורות"): a header button that opens its tools in a flyout beside the
 * palette (so the palette itself never grows tall). The header shows the active tool's icon and is
 * highlighted while one of the menu's tools is in use. Picking a tool, Esc or a click outside closes it.
 */
function ToolMenu({ menu, labels, open, onToggle, onClose, tool, onPick, className }: {
  menu: ToolMenuId;
  labels: boolean;
  open: boolean;
  onToggle(): void;
  onClose(): void;
  tool: string;
  onPick(id: ToolDef['id']): void;
  className: string;
}) {
  const items = TOOLS.filter((t) => t.menu === menu);
  const current = items.find((t) => t.id === tool);
  const title = TOOL_MENU_LABELS[menu];
  const headRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = headRef.current?.getBoundingClientRect();
      const pal = headRef.current?.closest('[data-testid="tool-palette"]')?.getBoundingClientRect();
      if (!r || !pal) return;
      const h = flyRef.current?.offsetHeight ?? 0;
      const top = Math.max(8, Math.min(r.top, window.innerHeight - h - 8));
      setPos({ top, right: window.innerWidth - pal.left + 6 });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (flyRef.current?.contains(t) || headRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={headRef} role="group" aria-label={title} data-testid={`${menu}-menu`} data-open={open ? 'true' : 'false'} className="flex shrink-0 flex-col gap-0.5">
      <ToolButton
        label={title}
        hint={open ? 'לחץ לסגירת האפשרויות' : `לחץ לפתיחת ${items.length} אפשרויות`}
        active={open || !!current}
        tooltipSide="left"
        onClick={onToggle}
        className={className + ' shrink-0'}
      >
        <span className="shrink-0">{current ? current.icon : MENU_ICON[menu]}</span>
        {labels && <span className="min-w-0 flex-1 truncate text-start text-[12px] font-semibold">{current ? current.short : title}</span>}
        <IconChevronDown size={labels ? 12 : 10} className={`shrink-0 opacity-70 rotate-90 ${labels ? '' : 'absolute bottom-0.5 left-0.5'}`} />
      </ToolButton>
      {open && createPortal(
        <div
          ref={flyRef}
          dir="rtl"
          data-viewer-ui
          data-testid={`${menu}-flyout`}
          className="fixed z-30 flex w-[11.5rem] flex-col gap-0.5 rounded-xl border border-slate-600/70 bg-slate-900/95 p-1 text-slate-200 shadow-xl shadow-black/40 backdrop-blur"
          style={pos ? { top: pos.top, right: pos.right } : { visibility: 'hidden', top: 0, right: 0 }}
        >
          <div className="select-none px-2 pb-0.5 pt-0.5 text-[10px] font-semibold text-slate-400">{title}</div>
          {items.map((t) => (
            <PaletteTool
              key={t.id}
              t={t}
              labels
              active={tool === t.id}
              onPick={() => {
                onPick(t.id);
                onClose();
              }}
              className="h-8 w-full justify-start gap-2 px-2"
            />
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

export function StyleButton({ labels, open, onToggle, className, tooltipSide = 'left' }: { labels: boolean; open: boolean; onToggle(): void; className: string; tooltipSide?: 'left' | 'top' }) {
  const color = useMarkup((s) => s.color);
  const width = useMarkup((s) => s.strokeWidth);
  return (
    <ToolButton label="צבע ועובי קו לסימון" active={open} tooltipSide={tooltipSide} onClick={onToggle} className={className + ' shrink-0'}>
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-slate-400"
        style={{ background: color ?? 'conic-gradient(#dc2626, #facc15, #16a34a, #2563eb, #9333ea, #dc2626)' }}
        data-testid="markup-style-swatch"
      />
      {labels && (
        <>
          <span className="min-w-0 flex-1 truncate text-start text-[12px]">סגנון</span>
          <span className="shrink-0 font-mono text-[9.5px] opacity-50">{width}px</span>
        </>
      )}
    </ToolButton>
  );
}

/** Colour + stroke width for new markup; also restyles the selected markup. */
export function StylePopover({ onClose, className }: { onClose(): void; className?: string }) {
  const color = useMarkup((s) => s.color);
  const width = useMarkup((s) => s.strokeWidth);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-testid="tool-palette"]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const applyToSelected = (patch: { color?: string; strokeWidth?: number }) => {
    const s = useViewer.getState();
    const m = s.selectedId ? s.measurements.find((x) => x.id === s.selectedId) : undefined;
    if (m && isMarkupKind(kindOf(m))) s.updateMeasurement(m.id, patch);
  };
  const pickColor = (c: string | null) => {
    useMarkup.getState().setColor(c);
    if (c) applyToSelected({ color: c });
  };
  const pickWidth = (w: number) => {
    useMarkup.getState().setStrokeWidth(w);
    applyToSelected({ strokeWidth: w });
  };

  return (
    <div
      ref={ref}
      dir="rtl"
      data-viewer-ui
      data-testid="markup-style-popover"
      className={
        (className ?? 'absolute right-full top-1/2 me-2 -translate-y-1/2') + ' w-44 rounded-lg border border-slate-600 bg-slate-900/95 p-2 text-[11px] text-slate-300 shadow-xl'
      }
    >
      <div className="mb-1 font-semibold text-slate-200">צבע</div>
      <div className="mb-2 grid grid-cols-6 gap-1.5" data-testid="markup-swatches">
        {MARKUP_SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            title={MARKUP_SWATCH_NAMES[c]}
            aria-label={`צבע ${MARKUP_SWATCH_NAMES[c]}`}
            aria-pressed={color === c}
            onClick={() => pickColor(c)}
            className={`h-5 w-5 rounded-full border border-slate-500 ${color === c ? 'ring-2 ring-sky-400 ring-offset-1 ring-offset-slate-900' : ''}`}
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="mb-1 font-semibold text-slate-200">עובי קו</div>
      <div className="flex gap-1">
        {STROKE_WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            aria-label={`עובי ${w}`}
            aria-pressed={width === w}
            onClick={() => pickWidth(w)}
            className={`flex h-7 flex-1 items-center justify-center rounded border ${width === w ? 'border-sky-500 bg-sky-900/50' : 'border-slate-600 hover:bg-slate-800'}`}
          >
            <span className="block w-5 rounded-full bg-slate-200" style={{ height: Math.max(1, w) }} />
          </button>
        ))}
      </div>
    </div>
  );
}
