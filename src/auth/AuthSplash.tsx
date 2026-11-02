import { WordmarkLogo } from './Logo';

/** Shown while the startup auth check runs, so the app never flashes for a signed-out visitor. */
export function AuthSplash() {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 bg-slate-900" data-testid="auth-splash" aria-busy="true">
      <WordmarkLogo className="h-auto w-[min(60vw,45vh)] select-none opacity-90" sizes="60vw" />
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-700 border-t-sky-400" role="status" aria-label="בודק כניסה…" />
    </div>
  );
}
