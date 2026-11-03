/**
 * Pricing state: a reusable GLOBAL price book (localStorage, shared by every
 * project on this device) + per-DOCUMENT overrides (saved with the document's
 * measurements by state/persistence.ts). Edits in the pricing panel go to the
 * document layer; "save as global" copies the effective prices to the global
 * book. Effective pricing = resolvePricing(global, doc).
 */
import { create } from 'zustand';
import {
  emptyPriceBook,
  resolvePricing,
  sanitizePriceBook,
  type CategoryPrice,
  type PriceBook,
  type PricingSettings,
  type ResolvedPricing,
} from './boq';

const GLOBAL_KEY = 'aluminum-pricebook-v1';

/** Settings that describe ONE project — never copied into the global book. */
const PROJECT_FIELDS: (keyof PricingSettings)[] = ['projectName', 'client'];

function loadGlobal(): PriceBook {
  try {
    const raw = localStorage.getItem(GLOBAL_KEY);
    return (raw && sanitizePriceBook(JSON.parse(raw))) || emptyPriceBook();
  } catch {
    return emptyPriceBook();
  }
}

function saveGlobal(b: PriceBook) {
  try {
    localStorage.setItem(GLOBAL_KEY, JSON.stringify(b));
  } catch {
    /* storage unavailable / full — the document layer still works */
  }
}

/** Drop undefined / NaN fields; returns undefined for an empty entry. */
function cleanEntry(c: CategoryPrice): CategoryPrice | undefined {
  const out: CategoryPrice = {};
  if (c.unit) out.unit = c.unit;
  for (const k of ['price', 'wastePct', 'labour'] as const) {
    const v = c[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface PricingState {
  global: PriceBook;
  doc: PriceBook;
  /**
   * Patch one category of the DOCUMENT layer. A field set to `undefined`
   * removes the document override (falls back to the global book / auto).
   */
  setCategory(category: string, patch: Partial<Record<keyof CategoryPrice, CategoryPrice[keyof CategoryPrice] | undefined>>): void;
  /** Patch document settings (VAT, discount, currency, project, client). */
  setSettings(patch: Partial<PricingSettings>): void;
  /** Copy the effective prices + VAT / discount / currency into the global book. */
  saveAsGlobal(): void;
  /** Forget this document's price overrides (project name / client are kept). */
  resetToGlobal(): void;
  /** Replace the document layer (persistence restore; null = empty). */
  setDocBook(b: PriceBook | null): void;
}

export const usePricing = create<PricingState>((set, get) => ({
  global: loadGlobal(),
  doc: emptyPriceBook(),

  setCategory: (category, patch) =>
    set((s) => {
      const merged = { ...s.doc.categories[category] } as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete merged[k];
        else merged[k] = v;
      }
      const entry = cleanEntry(merged as CategoryPrice);
      const categories = { ...s.doc.categories };
      if (entry) categories[category] = entry;
      else delete categories[category];
      return { doc: { ...s.doc, categories } };
    }),
  setSettings: (patch) => set((s) => ({ doc: { ...s.doc, settings: { ...s.doc.settings, ...patch } } })),
  saveAsGlobal: () => {
    const { global, doc } = get();
    const eff = resolvePricing(global, doc);
    const categories: Record<string, CategoryPrice> = {};
    for (const [k, c] of Object.entries(eff.categories)) {
      const e = cleanEntry(c);
      if (e) categories[k] = e;
    }
    const settings = { ...eff.settings } as Partial<PricingSettings>;
    for (const f of PROJECT_FIELDS) delete settings[f];
    const next: PriceBook = { categories, settings };
    saveGlobal(next);
    set({ global: next });
  },
  resetToGlobal: () =>
    set((s) => {
      const settings: Partial<PricingSettings> = {};
      for (const f of PROJECT_FIELDS) if (s.doc.settings[f] !== undefined) (settings as Record<string, unknown>)[f] = s.doc.settings[f];
      return { doc: { categories: {}, settings } };
    }),
  setDocBook: (b) => set({ doc: b ?? emptyPriceBook() }),
}));

/** Effective pricing (global + document) — for non-React callers (export). */
export function currentPricing(): ResolvedPricing {
  const { global, doc } = usePricing.getState();
  return resolvePricing(global, doc);
}

/** True when the document layer has anything worth saving. */
export function hasDocPricing(b: PriceBook): boolean {
  return Object.keys(b.categories).length > 0 || Object.values(b.settings).some((v) => v !== undefined && v !== '');
}

// Other tabs editing the global book.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === GLOBAL_KEY) usePricing.setState({ global: loadGlobal() });
  });
}
