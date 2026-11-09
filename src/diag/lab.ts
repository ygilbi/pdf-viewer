import { create } from 'zustand';

/**
 * "Crash lab": switches that turn off one part of the link callout / pinch pipeline at a time, so a
 * crash that only shows on a real iPhone can be bisected on the device itself (☰ → מעבדת אבחון).
 * Stored locally; all off by default. The active switches are included in crash reports.
 */
export interface LabFlags {
  /** Hide the whole SVG overlay (all measurements / markup) while a pinch runs. */
  hideOverlayOnPinch: boolean;
  /** Draw link callouts without any <text> (name, page, label). */
  noLinkText: boolean;
  /** Draw the link bubble solid instead of dashed. */
  noLinkDash: boolean;
  /** Draw only the bubble: no leader line, head circle or label. */
  noLinkHead: boolean;
  /** A new link is saved at once with default values: no editor card, no keyboard. */
  instantLink: boolean;
}

export const LAB_DEFAULTS: LabFlags = {
  hideOverlayOnPinch: false,
  noLinkText: false,
  noLinkDash: false,
  noLinkHead: false,
  instantLink: false,
};

export const LAB_LABELS: Record<keyof LabFlags, { title: string; desc: string }> = {
  instantLink: { title: 'קישור בלי חלון עריכה', desc: 'קישור חדש נשמר מיד, בלי חלון ובלי מקלדת' },
  hideOverlayOnPinch: { title: 'הסתר סימונים בזמן צביטה', desc: 'כל הסימונים נעלמים בזמן הזום וחוזרים אחריו' },
  noLinkText: { title: 'קישור בלי טקסט', desc: 'העיגול ריק: בלי שם, עמוד ותווית' },
  noLinkDash: { title: 'קישור בלי מקווקו', desc: 'מסגרת רציפה במקום מקווקו' },
  noLinkHead: { title: 'קישור בלי עיגול', desc: 'רק המסגרת, בלי קו וראש' },
};

const KEY = 'pdfv-lab-v1';

function load(): LabFlags {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<LabFlags>;
    const out = { ...LAB_DEFAULTS };
    for (const k of Object.keys(LAB_DEFAULTS) as (keyof LabFlags)[]) if (typeof raw[k] === 'boolean') out[k] = raw[k]!;
    return out;
  } catch {
    return { ...LAB_DEFAULTS };
  }
}

function save(f: LabFlags): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* storage unavailable: flags last for this session only */
  }
}

interface LabState extends LabFlags {
  setFlag(k: keyof LabFlags, v: boolean): void;
  reset(): void;
}

export const useLab = create<LabState>((set, get) => ({
  ...load(),
  setFlag: (k, v) => {
    set({ [k]: v } as Partial<LabFlags>);
    save(pick(get()));
  },
  reset: () => {
    set({ ...LAB_DEFAULTS });
    save({ ...LAB_DEFAULTS });
  },
}));

function pick(s: LabFlags): LabFlags {
  return {
    hideOverlayOnPinch: s.hideOverlayOnPinch,
    noLinkText: s.noLinkText,
    noLinkDash: s.noLinkDash,
    noLinkHead: s.noLinkHead,
    instantLink: s.instantLink,
  };
}

/** Short list of switched-on flags for crash reports ("" when none). */
export function labSummary(f: LabFlags = pick(useLab.getState())): string {
  return (Object.keys(LAB_DEFAULTS) as (keyof LabFlags)[]).filter((k) => f[k]).join(',');
}
