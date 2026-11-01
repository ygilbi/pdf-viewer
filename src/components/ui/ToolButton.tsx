import type { ReactNode } from 'react';

interface ToolButtonProps {
  label: string;
  shortcut?: string;
  /** Extra line shown under the label in the tooltip. */
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  /** Show the label text next to the icon. */
  showLabel?: boolean;
  /** Extra classes for the label text (e.g. responsive hiding). */
  labelClassName?: string;
  className?: string;
}

/** Compact CAD-style toolbar button with a hover tooltip (label + shortcut). */
export function ToolButton({
  label,
  shortcut,
  hint,
  active,
  disabled,
  onClick,
  children,
  showLabel,
  labelClassName = '',
  className = '',
}: ToolButtonProps) {
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={
          'flex h-8 items-center gap-1.5 rounded px-2 text-xs transition-colors ' +
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 ' +
          'disabled:cursor-not-allowed disabled:opacity-40 ' +
          (active
            ? 'bg-sky-600 text-white shadow-inner'
            : 'text-slate-300 hover:bg-slate-700 hover:text-white') +
          ' ' +
          className
        }
      >
        {children}
        {showLabel && <span className={`whitespace-nowrap ${labelClassName}`}>{label}</span>}
      </button>
      <div
        role="tooltip"
        className={
          'pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap ' +
          'rounded border border-slate-600 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 opacity-0 shadow-lg ' +
          'transition-opacity delay-300 group-hover:opacity-100'
        }
      >
        {label}
        {shortcut && (
          <kbd className="ms-2 rounded border border-slate-600 bg-slate-800 px-1 font-mono text-[10px] text-slate-300">
            {shortcut}
          </kbd>
        )}
        {hint && <div className="mt-0.5 text-[10px] text-slate-400">{hint}</div>}
      </div>
    </div>
  );
}

export function ToolbarDivider() {
  return <div className="mx-1 h-5 w-px bg-slate-700" aria-hidden="true" />;
}
