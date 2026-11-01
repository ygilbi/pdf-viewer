import { useViewer } from '../state/store';
import { UNCATEGORIZED_LABEL } from '../core/measurementEngine';

const NEW = '__new__';

/** Ask for a new category name; returns its id (or null when cancelled). */
export function promptNewCategory(): string | null {
  const name = window.prompt('שם הקטגוריה החדשה')?.trim();
  if (!name) return null;
  const s = useViewer.getState();
  const existing = s.categories.find((c) => c.name === name);
  return existing ? existing.id : s.addCategory(name);
}

/**
 * Toolbar selector for the *active* category: new measurements get this
 * category and its color. Includes "new category…".
 */
export function ActiveCategorySelect({ disabled }: { disabled?: boolean }) {
  const categories = useViewer((s) => s.categories);
  const activeId = useViewer((s) => s.activeCategoryId);
  const setActive = useViewer((s) => s.setActiveCategory);
  const active = categories.find((c) => c.id === activeId);
  return (
    <label
      className="flex h-7 items-center gap-1 rounded border border-slate-600 bg-slate-900/60 px-1.5 text-[11px] text-slate-400"
      title="קטגוריה למדידות חדשות (צבע המדידה לפי הקטגוריה)"
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full border border-slate-500"
        style={{ background: active?.color ?? 'transparent' }}
      />
      <select
        aria-label="קטגוריה פעילה"
        data-testid="active-category"
        disabled={disabled}
        value={activeId ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === NEW) {
            const id = promptNewCategory();
            if (id) setActive(id);
          } else setActive(v || null);
          e.target.blur();
        }}
        className="max-w-[5.5rem] bg-transparent text-xs text-slate-100 focus:outline-none disabled:opacity-40 [&>option]:bg-slate-800"
      >
        <option value="">{UNCATEGORIZED_LABEL}</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        <option value={NEW}>+ קטגוריה חדשה…</option>
      </select>
    </label>
  );
}

/** Small per-measurement category select (panel rows). */
export function MeasurementCategorySelect({ id, value }: { id: string; value: string }) {
  const categories = useViewer((s) => s.categories);
  const setCategory = useViewer((s) => s.setMeasurementCategory);
  const known = !value || categories.some((c) => c.id === value);
  return (
    <select
      aria-label="קטגוריית המדידה"
      data-testid="row-category"
      value={value}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = e.target.value;
        if (v === NEW) {
          const nid = promptNewCategory();
          if (nid) setCategory(id, nid);
        } else setCategory(id, v || null);
      }}
      className="h-5 max-w-[6.5rem] shrink-0 rounded border border-slate-700 bg-slate-900 px-0.5 text-[10px] text-slate-300 focus:border-sky-500 focus:outline-none"
    >
      <option value="">{UNCATEGORIZED_LABEL}</option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
      {!known && <option value={value}>{value}</option>}
      <option value={NEW}>+ חדשה…</option>
    </select>
  );
}
