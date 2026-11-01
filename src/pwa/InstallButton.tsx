import { useInstallPrompt } from './installPrompt';

export interface InstallButtonProps {
  /** Replaces the default Tailwind classes. */
  className?: string;
  /** Button text (default: "התקן כאפליקציה"). */
  label?: string;
}

/** Renders only while the browser offers PWA installation; otherwise null. */
export function InstallButton({ className, label = 'התקן כאפליקציה' }: InstallButtonProps) {
  const { canInstall, promptInstall } = useInstallPrompt();
  if (!canInstall) return null;
  return (
    <button
      type="button"
      onClick={() => void promptInstall()}
      title="התקנת האפליקציה כדי לפתוח קובצי PDF ישירות מהמחשב"
      className={
        className ??
        'inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300'
      }
    >
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" />
      </svg>
      {label}
    </button>
  );
}
