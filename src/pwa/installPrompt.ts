/**
 * Captures `beforeinstallprompt` as early as possible (this module is imported
 * from register.ts, loaded by index.html) so the in-app install button works
 * even if the event fires before React mounts.
 */
import { useSyncExternalStore } from 'react';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // suppress the mini-infobar; we show our own button
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getSnapshot = () => deferred !== null;
const getServerSnapshot = () => false;

/** Shows the browser's install dialog. Resolves to true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null; // an event can be prompted only once
  emit();
  await e.prompt();
  const { outcome } = await e.userChoice;
  return outcome === 'accepted';
}

/** `canInstall` is true while the browser offers installation (not yet installed). */
export function useInstallPrompt(): { canInstall: boolean; promptInstall: () => Promise<boolean> } {
  const canInstall = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { canInstall, promptInstall };
}
