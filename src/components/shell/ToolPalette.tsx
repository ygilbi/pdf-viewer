import { useViewer } from '../../state/store';
import { useUi } from '../../state/uiStore';
import { ToolButton } from '../ui/ToolButton';
import { IconCollapse } from '../ui/icons';
import { TOOLS } from '../toolActions';

/** Thumbnail drawer width (ThumbnailSidebar is 184px) + gap, so the palette slides clear of it. */
const THUMBS_OFFSET = 184 + 8;

/**
 * Compact vertical tool palette on the right (RTL start) edge. Icons only,
 * tooltips carry name + shortcut. Collapses to a single button showing the
 * active tool. Keyboard shortcuts work regardless (useToolShortcuts).
 */
export function ToolPalette() {
  const tool = useViewer((s) => s.tool);
  const setTool = useViewer((s) => s.setTool);
  const collapsed = useUi((s) => s.paletteCollapsed);
  const setCollapsed = useUi((s) => s.setPaletteCollapsed);
  const thumbsOpen = useUi((s) => s.thumbsOpen);
  const active = TOOLS.find((t) => t.id === tool) ?? TOOLS[0];

  return (
    <div
      data-testid="tool-palette"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={
        'absolute top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-0.5 rounded-xl border border-slate-600/70 ' +
        'bg-slate-900/80 p-1 text-slate-200 shadow-lg shadow-black/40 backdrop-blur ' +
        'transition-[right] duration-200 ease-out motion-reduce:transition-none'
      }
      style={{ right: thumbsOpen ? THUMBS_OFFSET : 8 }}
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
          <div role="toolbar" aria-label="כלים" aria-orientation="vertical" className="flex flex-col gap-0.5">
            {TOOLS.map((t) => (
              <ToolButton
                key={t.id}
                label={t.label}
                shortcut={t.shortcut}
                active={tool === t.id}
                tooltipSide="left"
                onClick={() => setTool(t.id)}
                className="h-9 w-9 justify-center px-0"
              >
                {t.icon}
              </ToolButton>
            ))}
          </div>
          <span className="my-0.5 h-px w-6 bg-slate-700" aria-hidden="true" />
          <ToolButton
            label="כווץ סרגל כלים"
            tooltipSide="left"
            onClick={() => setCollapsed(true)}
            className="h-6 w-9 justify-center px-0 text-slate-400"
          >
            <IconCollapse size={14} />
          </ToolButton>
        </>
      )}
    </div>
  );
}
