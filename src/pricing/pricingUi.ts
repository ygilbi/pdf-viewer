import { create } from 'zustand';

export type LeftTab = 'measurements' | 'items';

/** Which tab the left drawer shows (not persisted). */
export const usePricingUi = create<{ tab: LeftTab; setTab(tab: LeftTab): void }>((set) => ({
  tab: 'measurements',
  setTab: (tab) => set({ tab }),
}));
