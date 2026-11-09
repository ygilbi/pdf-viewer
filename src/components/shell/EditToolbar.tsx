import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useViewer } from '../../state/store';
import type { ToolId } from '../../core/types';
import { TOOLS, TOOL_GROUP_LABELS, TOOL_MENU_LABELS, type ToolDef, type ToolGroup, type ToolMenuId } from '../toolActions';
import { IconChevronDown } from '../ui/icons';
import { MENU_AFTER, MENU_ICON, StyleButton, StylePopover, TOOL_GROUPS } from './ToolPalette';
import { HintsToggle } from './HintPanel';

const groupOf = (tool: ToolId): ToolGroup | undefined => TOOLS.find((t) => t.id === tool)?.group;

const barBtn =
  'relative flex h-12 min-w-[3.25rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[10px] leading-none transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ';
const barCls = (active: boolean) => barBtn + (active ? 'bg-sky-600 text-white shadow-inner' : 'text-slate-300 active:bg-slate-700 hover:bg-slate-700/70');

function BarTool({ t, active, onPick }: { t: ToolDef; active: boolean; onPick(): void }) {
  return (
    <button type="button" aria-label={t.label} aria-pressed={active} title={t.hint ?? t.label} onClick={onPick} className={barCls(active)}>
      <span className="shrink-0">{t.icon}</span>
      <span className="max-w-[4.5rem] truncate">{t.short}</span>
    </button>
  );
}

/**
 * Edit mode on a phone / tablet: one bottom toolbar instead of the right palette — group tabs
 * (מדידה · סימון · מסמך, from TOOLS / TOOL_GROUP_LABELS) over a horizontally scrolling row of the
 * group's tools. The expandable menus ("חישוב שטח", "צורות") and the style swatch open as popovers
 * above the toolbar. `toggle` ("✓ סיום עריכה") stays pinned at the row's end.
 */
export function EditToolbar({ toggle }: { toggle: ReactNode }) {
  const tool = useViewer((s) => s.tool);
  const setTool = useViewer((s) => s.setTool);
  const [group, setGroup] = useState<ToolGroup>(() => groupOf(tool) ?? TOOL_GROUPS[0]);
  const [pop, setPop] = useState<ToolMenuId | 'style' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // A tool picked by keyboard (or from the items panel) shows its group.
  useEffect(() => {
    const g = groupOf(tool);
    if (g) setGroup(g);
    setPop((p) => (p === 'style' ? p : null));
  }, [tool]);

  useEffect(() => {
    if (!pop) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && !ref.current?.contains(t) && !t.closest?.('[data-testid="markup-style-popover"]')) setPop(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [pop]);

  const pick = (id: ToolId) => {
    setTool(id);
    setPop(null);
  };

  const row: ReactNode[] = [];
  for (const t of TOOLS.filter((x) => x.group === group && !x.menu)) {
    row.push(<BarTool key={t.id} t={t} active={tool === t.id} onPick={() => pick(t.id)} />);
    const m = MENU_AFTER[t.id];
    if (!m) continue;
    const items = TOOLS.filter((x) => x.menu === m);
    const current = items.find((x) => x.id === tool);
    row.push(
      <button
        key={`menu-${m}`}
        type="button"
        data-testid={`${m}-menu`}
        data-open={pop === m ? 'true' : 'false'}
        aria-expanded={pop === m}
        aria-label={TOOL_MENU_LABELS[m]}
        title={`${TOOL_MENU_LABELS[m]} — ${items.length} אפשרויות`}
        onClick={() => setPop(pop === m ? null : m)}
        className={barCls(!!current || pop === m)}
      >
        <span className="shrink-0">{current ? current.icon : MENU_ICON[m]}</span>
        <span className="flex max-w-[4.5rem] items-center gap-0.5 truncate">
          {current ? current.short : TOOL_MENU_LABELS[m]}
          <IconChevronDown size={9} className={pop === m ? '' : 'rotate-180'} />
        </span>
      </button>,
    );
  }
  if (group === 'markup')
    row.push(
      <div key="style" className="shrink-0">
        <StyleButton
          labels={false}
          open={pop === 'style'}
          onToggle={() => setPop(pop === 'style' ? null : 'style')}
          className="h-12 w-11 justify-center px-0"
          tooltipSide="top"
        />
      </div>,
    );

  return (
    <div
      ref={ref}
      dir="rtl"
      data-testid="tool-palette"
      data-variant="bar"
      data-viewer-ui
      className="pointer-events-auto relative w-full border-t border-slate-600/70 bg-slate-900/95 text-slate-200 shadow-[0_-4px_16px_rgba(0,0,0,0.35)] backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {pop && pop !== 'style' && (
        <div className="absolute inset-x-2 bottom-full mb-1.5 flex justify-center">
          <div
            role="menu"
            aria-label={TOOL_MENU_LABELS[pop]}
            data-testid={`${pop}-menu-popover`}
            className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-600 bg-slate-900 p-1 shadow-xl shadow-black/50 [scrollbar-width:none]"
          >
            {TOOLS.filter((t) => t.menu === pop).map((t) => (
              <BarTool key={t.id} t={t} active={tool === t.id} onPick={() => pick(t.id)} />
            ))}
          </div>
        </div>
      )}
      {pop === 'style' && <StylePopover onClose={() => setPop(null)} className="absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2" />}
      <div className="flex items-center gap-1 px-2 pt-1">
        <div role="tablist" aria-label="קבוצות כלים" className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
          {TOOL_GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={group === g}
              data-testid={`tool-group-${g}`}
              onClick={() => {
                setGroup(g);
                setPop(null);
              }}
              className={
                'h-7 shrink-0 rounded-full px-3 text-[12px] font-semibold transition-colors ' +
                (group === g ? 'bg-slate-200 text-slate-900' : 'text-slate-400 hover:bg-slate-800 hover:text-white') +
                (groupOf(tool) === g && group !== g ? ' ring-1 ring-sky-500' : '')
              }
            >
              {TOOL_GROUP_LABELS[g]}
            </button>
          ))}
        </div>
        <HintsToggle />
      </div>
      <div className="flex items-center gap-1 px-2 py-1">
        <div role="toolbar" aria-label="כלים" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-contain [scrollbar-width:none]">
          {row}
        </div>
        <span className="h-10 w-px shrink-0 bg-slate-700" aria-hidden="true" />
        {toggle}
      </div>
    </div>
  );
}
