/**
 * "Set as default PDF app" onboarding — pure decision logic (no React, no DOM
 * globals at import time, so it unit-tests under Node).
 *
 * Reality: neither Windows 10/11 nor macOS lets an app make itself the default
 * handler programmatically; the user must confirm in the OS UI. An installed
 * PWA with `file_handlers` is registered as a .pdf handler (Open with… /
 * Default apps), so all we can do is ask at the right time and walk the user
 * through the OS steps. Once the PWA is the default, Explorer/Finder show the
 * manifest's file-handler icon on .pdf files.
 */

export type Os = 'windows' | 'mac' | 'other';

export type PromptStatus =
  /** Ask on the next eligible standalone launch (after `remindAt`). */
  | 'pending'
  /** User said "כבר הגדרתי". */
  | 'done'
  /** User said "אל תשאל שוב". */
  | 'never'
  /** Launched with a file from a cold start often enough — almost certainly the default. */
  | 'likely-default';

export interface PromptState {
  status: PromptStatus;
  /** Epoch ms; auto-prompt is suppressed until then ("remind me later"). */
  remindAt: number;
  /** Cold starts that arrived through launchQueue with files (double-click / Open with). */
  coldFileLaunches: number;
}

export type PromptChoice = 'done' | 'later' | 'never';

export const STORAGE_KEY = 'pdf-viewer:default-app:v1';
export const REMIND_LATER_MS = 24 * 60 * 60 * 1000;
/**
 * Cold file launches after which we stop asking. One is not enough: "Open
 * with → PDF Viewer" (without "Always") is also a cold file launch.
 */
export const LIKELY_DEFAULT_LAUNCHES = 2;
/** A launch with files this soon after navigation start is the launch that opened the window. */
export const COLD_START_WINDOW_MS = 10_000;

export const INITIAL_STATE: PromptState = { status: 'pending', remindAt: 0, coldFileLaunches: 0 };

interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string } | null;
}

/** Desktop OS from UA-CH (preferred) or the UA string. iPadOS (Mac UA + touch) → 'other'. */
export function detectOs(nav: NavigatorLike | undefined): Os {
  if (!nav) return 'other';
  const ch = nav.userAgentData?.platform?.toLowerCase() ?? '';
  if (ch) {
    if (ch === 'windows') return 'windows';
    if (ch === 'macos') return 'mac';
    return 'other';
  }
  const ua = nav.userAgent ?? '';
  if (/Windows NT|Win64|Win32/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return (nav.maxTouchPoints ?? 0) > 1 ? 'other' : 'mac';
  if (/^Win/i.test(nav.platform ?? '')) return 'windows';
  return 'other';
}

interface WindowLike {
  matchMedia?: (q: string) => { matches: boolean };
  navigator?: object;
}
type StandaloneNavigator = { standalone?: boolean; windowControlsOverlay?: { visible?: boolean } };

/** Running as an installed app window (not a browser tab). */
export function isStandalone(win: WindowLike | undefined): boolean {
  if (!win) return false;
  const mm = (q: string) => {
    try {
      return !!win.matchMedia?.(q).matches;
    } catch {
      return false;
    }
  };
  const nav = win.navigator as StandaloneNavigator | undefined;
  return (
    mm('(display-mode: standalone)') ||
    mm('(display-mode: window-controls-overlay)') ||
    mm('(display-mode: minimal-ui)') ||
    mm('(display-mode: fullscreen)') ||
    nav?.standalone === true ||
    nav?.windowControlsOverlay?.visible === true
  );
}

export interface PromptContext {
  os: Os;
  standalone: boolean;
  /** This session was started by opening a file (launchQueue delivered files). */
  launchedWithFile: boolean;
  state: PromptState;
  now: number;
}

/** Whether to open the onboarding modal automatically on this launch. */
export function shouldAutoPrompt({ os, standalone, launchedWithFile, state, now }: PromptContext): boolean {
  if (os === 'other') return false; // no supported OS flow (Linux, ChromeOS, mobile)
  if (!standalone) return false; // browser tab: install first (InstallButton + toast handle that)
  if (launchedWithFile) return false; // opened via a PDF → probably already the handler; don't interrupt
  if (state.status !== 'pending') return false;
  return now >= state.remindAt;
}

// ---------------------------------------------------------------- desktop app (Electron, Windows)

/**
 * Desktop app: on EVERY start, while PDF Viewer is not the default PDF app, a popup asks
 * "להגדיר את PDF Viewer כתוכנה שפותחת קובצי PDF?" (הגדר / לא עכשיו). The last answer is still
 * recorded in the desktop shell's userData/prefs.json (pref key below) for diagnostics, but it
 * no longer suppresses the question — only "already the default" does.
 */
export const DESKTOP_PROMPT_PREF = 'defaultPdfPrompt' as const;

/** yes = "הגדר"; no = "לא עכשיו" (also Esc / ×); already-default = the registry said so (older shells' record). */
export type DesktopAnswer = 'yes' | 'no' | 'already-default';

export interface DesktopPromptRecord {
  answered: true;
  answer: DesktopAnswer;
  /** ISO timestamp. */
  at: string;
}

const DESKTOP_ANSWERS: readonly DesktopAnswer[] = ['yes', 'no', 'already-default'];

export function makeDesktopRecord(answer: DesktopAnswer, now: number): DesktopPromptRecord {
  return { answered: true, answer, at: new Date(now).toISOString() };
}

/** Tolerant read of the stored pref: anything with `answered: true` counts as answered. */
export function parseDesktopRecord(v: unknown): DesktopPromptRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Partial<DesktopPromptRecord>;
  if (r.answered !== true) return null;
  return {
    answered: true,
    answer: DESKTOP_ANSWERS.includes(r.answer as DesktopAnswer) ? (r.answer as DesktopAnswer) : 'no',
    at: typeof r.at === 'string' ? r.at : '',
  };
}

export type DesktopStartupAction =
  /** PDF Viewer already opens PDF files: say nothing. */
  | 'skip'
  /** Show the popup. */
  | 'ask';

/**
 * Startup decision (desktop app, Windows). `isDefault` comes from the registry (the .pdf
 * UserChoice / UserChoiceLatest ProgId): true = PDF Viewer, false = another app, null = no user
 * choice at all (Windows then falls back to its built-in default, i.e. not us) or the query
 * failed — asked as well, since we cannot tell that we are the default.
 */
export function desktopStartupAction(isDefault: boolean | null): DesktopStartupAction {
  return isDefault === true ? 'skip' : 'ask';
}

export function applyChoice(state: PromptState, choice: PromptChoice, now: number): PromptState {
  switch (choice) {
    case 'done':
      return { ...state, status: 'done' };
    case 'never':
      return { ...state, status: 'never' };
    case 'later':
      return { ...state, status: 'pending', remindAt: now + REMIND_LATER_MS };
  }
}

/** Record a launchQueue delivery with files. Only cold starts count toward "likely default". */
export function recordFileLaunch(state: PromptState, cold: boolean): PromptState {
  if (!cold) return state;
  const coldFileLaunches = state.coldFileLaunches + 1;
  const status = state.status === 'pending' && coldFileLaunches >= LIKELY_DEFAULT_LAUNCHES ? 'likely-default' : state.status;
  return { ...state, coldFileLaunches, status };
}

const STATUSES: readonly PromptStatus[] = ['pending', 'done', 'never', 'likely-default'];

/** Tolerant parse of the persisted JSON (missing / corrupt → initial state). */
export function parseState(raw: string | null | undefined): PromptState {
  if (!raw) return { ...INITIAL_STATE };
  try {
    const v = JSON.parse(raw) as Partial<PromptState>;
    return {
      status: STATUSES.includes(v.status as PromptStatus) ? (v.status as PromptStatus) : 'pending',
      remindAt: Number.isFinite(v.remindAt) ? Number(v.remindAt) : 0,
      coldFileLaunches: Number.isFinite(v.coldFileLaunches) ? Math.max(0, Math.floor(Number(v.coldFileLaunches))) : 0,
    };
  } catch {
    return { ...INITIAL_STATE };
  }
}

export function loadState(): PromptState {
  try {
    return parseState(globalThis.localStorage?.getItem(STORAGE_KEY));
  } catch {
    return { ...INITIAL_STATE };
  }
}

export function saveState(state: PromptState): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / blocked storage: the prompt simply returns next launch */
  }
}

/** Windows Settings › Apps › Default apps. Chrome/Edge ask "Open Settings?" first. */
export const WINDOWS_DEFAULT_APPS_URI = 'ms-settings:defaultapps';
/** Desktop app: Settings › Apps › Default apps › PDF Viewer (registered by the installer under RegisteredApplications). */
export const WINDOWS_APP_DEFAULTS_URI = 'ms-settings:defaultapps?registeredAppUser=PDF%20Viewer';
