import { Fragment, useEffect, useRef, useState } from 'react';
import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { useMarkup } from '../../state/markupStore';
import { ToolButton } from '../ui/ToolButton';
import { IconCollapse, IconLabels } from '../ui/icons';
import { TOOLS, TOOL_GROUP_LABELS, type ToolGroup } from '../toolActions';
import { STROKE_WIDTHS } from '../../core/markupGeometry';
import { isMarkupKind, kindOf } from '../../core/measurementEngine';

/** Thumbnail drawer width (ThumbnailSidebar is 184px) + gap, so the palette slides clear of it. */
const THUMBS_OFFSET = 184 + 8;
const LABELS_KEY = 'aluminum-palette-labels-v1';

/** Colours offered for markup (null = follow the active category). */
export const MARKUP_SWATCHES = ['#dc2626', '#ea580c', '#facc15', '#16a34a', '#2563eb', '#9333ea', '#0f172a'];

function loadLabels(): boolean {
  try {
    const v = localStorage.getItem(LABELS_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

const GROUPS: ToolGroup[] = ['measure', 'markup'];

/**
 * Vertical tool palette on the right (RTL start) edge. Shows Hebrew labels
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
        'absolute top-1/2 z-20 flex -translate-y-1/2 flex-col rounded-xl border border-slate-600/70 ' +
        'bg-slate-900/85 p-1 text-slate-200 shadow-lg shadow-black/40 backdrop-blur ' +
        'transition-[right] duration-200 ease-out motion-reduce:transition-none ' +
        (labels && !collapsed ? 'items-stretch' : 'items-center')
      }
      style={{ right: thumbsOpen ? THUMBS_OFFSET : 8, maxHeight: 'calc(100% - 128px)' }}
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
              'flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain ' + (labels ? 'w-[8.5rem]' : 'items-center')
            }
            style={{ scrollbarWidth: 'thin' }}
          >
            {GROUPS.map((g, gi) => (
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
                {TOOLS.filter((t) => t.group === g).map((t) => (
                  <ToolButton
                    key={t.id}
                    label={t.label}
                    shortcut={t.shortcut}
                    hint={t.hint}
                    active={tool === t.id}
                    tooltipSide="left"
                    onClick={() => setTool(t.id)}
                    className={btnCls + ' shrink-0'}
                  >
                    <span className="shrink-0">{t.icon}</span>
                    {labels && (
                      <>
                        <span className="min-w-0 flex-1 truncate text-start text-[12px]">{t.short}</span>
                        <kbd className="shrink-0 font-mono text-[9.5px] text-current opacity-50">{t.shortcut.split(' ')[0]}</kbd>
                      </>
                    )}
                  </ToolButton>
                ))}
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

function StyleButton({ labels, open, onToggle, className }: { labels: boolean; open: boolean; onToggle(): void; className: string }) {
  const color = useMarkup((s) => s.color);
  const width = useMarkup((s) => s.strokeWidth);
  return (
    <ToolButton label="צבע ועובי קו לסימון" active={open} tooltipSide="left" onClick={onToggle} className={className + ' shrink-0'}>
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
function StylePopover({ onClose }: { onClose(): void }) {
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
      className="absolute right-full top-1/2 me-2 w-44 -translate-y-1/2 rounded-lg border border-slate-600 bg-slate-900/95 p-2 text-[11px] text-slate-300 shadow-xl"
    >
      <div className="mb-1 font-semibold text-slate-200">צבע</div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          title="לפי קטגוריה"
          aria-label="צבע לפי קטגוריה"
          aria-pressed={color === null}
          onClick={() => pickColor(null)}
          className={`h-5 w-5 rounded-full border ${color === null ? 'ring-2 ring-sky-400 ring-offset-1 ring-offset-slate-900' : 'border-slate-500'}`}
          style={{ background: 'conic-gradient(#dc2626, #facc15, #16a34a, #2563eb, #9333ea, #dc2626)' }}
        />
        {MARKUP_SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`צבע ${c}`}
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
