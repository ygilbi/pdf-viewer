import { describe, expect, it } from 'vitest';
import {
  INITIAL_STATE,
  LIKELY_DEFAULT_LAUNCHES,
  REMIND_LATER_MS,
  applyChoice,
  detectOs,
  isStandalone,
  parseState,
  recordFileLaunch,
  shouldAutoPrompt,
  desktopFirstRunAction,
  makeDesktopRecord,
  parseDesktopRecord,
  type PromptContext,
} from './defaultApp';

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

describe('detectOs', () => {
  it('prefers UA-CH platform', () => {
    expect(detectOs({ userAgentData: { platform: 'Windows' }, userAgent: MAC_UA })).toBe('windows');
    expect(detectOs({ userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(detectOs({ userAgentData: { platform: 'Linux' }, userAgent: WIN_UA })).toBe('other');
    expect(detectOs({ userAgentData: { platform: 'Chrome OS' } })).toBe('other');
  });
  it('falls back to the UA string', () => {
    expect(detectOs({ userAgent: WIN_UA })).toBe('windows');
    expect(detectOs({ userAgent: MAC_UA, maxTouchPoints: 0 })).toBe('mac');
    expect(detectOs({ userAgent: LINUX_UA })).toBe('other');
    expect(detectOs({ userAgentData: { platform: '' }, userAgent: WIN_UA })).toBe('windows');
  });
  it('treats iPadOS (Mac UA with touch) and missing navigator as other', () => {
    expect(detectOs({ userAgent: MAC_UA, maxTouchPoints: 5 })).toBe('other');
    expect(detectOs(undefined)).toBe('other');
  });
});

describe('isStandalone', () => {
  const mm = (match: string) => (q: string) => ({ matches: q === match });
  it('detects installed display modes', () => {
    expect(isStandalone({ matchMedia: mm('(display-mode: standalone)') })).toBe(true);
    expect(isStandalone({ matchMedia: mm('(display-mode: window-controls-overlay)') })).toBe(true);
    expect(isStandalone({ matchMedia: mm('(display-mode: browser)') })).toBe(false);
    expect(isStandalone({ matchMedia: mm('x'), navigator: { windowControlsOverlay: { visible: true } } })).toBe(true);
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true);
    expect(isStandalone(undefined)).toBe(false);
  });
  it('survives a throwing matchMedia', () => {
    expect(
      isStandalone({
        matchMedia: () => {
          throw new Error('nope');
        },
      }),
    ).toBe(false);
  });
});

describe('shouldAutoPrompt', () => {
  const base: PromptContext = { os: 'windows', standalone: true, launchedWithFile: false, state: INITIAL_STATE, now: 1000 };
  it('asks on the first standalone launch on Windows and macOS', () => {
    expect(shouldAutoPrompt(base)).toBe(true);
    expect(shouldAutoPrompt({ ...base, os: 'mac' })).toBe(true);
  });
  it('skips other OSes, browser tabs and file launches', () => {
    expect(shouldAutoPrompt({ ...base, os: 'other' })).toBe(false);
    expect(shouldAutoPrompt({ ...base, standalone: false })).toBe(false);
    expect(shouldAutoPrompt({ ...base, launchedWithFile: true })).toBe(false);
  });
  it('respects dismiss states', () => {
    expect(shouldAutoPrompt({ ...base, state: applyChoice(INITIAL_STATE, 'done', 0) })).toBe(false);
    expect(shouldAutoPrompt({ ...base, state: applyChoice(INITIAL_STATE, 'never', 0) })).toBe(false);
    expect(shouldAutoPrompt({ ...base, state: { ...INITIAL_STATE, status: 'likely-default' } })).toBe(false);
  });
  it('"remind me later" waits a day', () => {
    const later = applyChoice(INITIAL_STATE, 'later', 1000);
    expect(later).toEqual({ status: 'pending', remindAt: 1000 + REMIND_LATER_MS, coldFileLaunches: 0 });
    expect(shouldAutoPrompt({ ...base, state: later, now: 2000 })).toBe(false);
    expect(shouldAutoPrompt({ ...base, state: later, now: 1000 + REMIND_LATER_MS })).toBe(true);
  });
});

describe('recordFileLaunch', () => {
  it('counts only cold starts and flips to likely-default at the threshold', () => {
    let s = recordFileLaunch(INITIAL_STATE, false);
    expect(s).toEqual(INITIAL_STATE);
    for (let i = 0; i < LIKELY_DEFAULT_LAUNCHES - 1; i++) s = recordFileLaunch(s, true);
    expect(s.status).toBe('pending');
    s = recordFileLaunch(s, true);
    expect(s).toMatchObject({ status: 'likely-default', coldFileLaunches: LIKELY_DEFAULT_LAUNCHES });
  });
  it('does not override an explicit choice', () => {
    let s = applyChoice(INITIAL_STATE, 'never', 0);
    for (let i = 0; i < 5; i++) s = recordFileLaunch(s, true);
    expect(s.status).toBe('never');
  });
});

describe('parseState', () => {
  it('tolerates missing / corrupt / partial data', () => {
    expect(parseState(null)).toEqual(INITIAL_STATE);
    expect(parseState('{oops')).toEqual(INITIAL_STATE);
    expect(parseState('{"status":"weird","remindAt":"x"}')).toEqual(INITIAL_STATE);
    expect(parseState('{"status":"never","remindAt":5,"coldFileLaunches":1}')).toEqual({ status: 'never', remindAt: 5, coldFileLaunches: 1 });
  });
});

describe('desktop: ask once', () => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0);
  it('asks on the first launch while another app (or nothing) is the default', () => {
    expect(desktopFirstRunAction({ stored: null, isDefault: false })).toBe('ask');
    expect(desktopFirstRunAction({ stored: null, isDefault: null })).toBe('ask');
  });
  it('does not ask when already the default, but settles the question', () => {
    expect(desktopFirstRunAction({ stored: null, isDefault: true })).toBe('mark-already-default');
  });
  it('never asks again once answered, whatever the registry says', () => {
    for (const answer of ['yes', 'no', 'already-default'] as const) {
      const stored = JSON.parse(JSON.stringify(makeDesktopRecord(answer, now))) as unknown; // round-trip like prefs.json
      expect(desktopFirstRunAction({ stored, isDefault: false })).toBe('skip');
      expect(desktopFirstRunAction({ stored, isDefault: null })).toBe('skip');
      expect(desktopFirstRunAction({ stored, isDefault: true })).toBe('skip');
    }
  });
  it('does not ask when the answer cannot be stored / read (would re-ask every launch)', () => {
    expect(desktopFirstRunAction({ stored: undefined, isDefault: false })).toBe('skip');
  });
  it('ignores junk in prefs.json', () => {
    expect(desktopFirstRunAction({ stored: { answered: 'yes' }, isDefault: false })).toBe('ask');
    expect(desktopFirstRunAction({ stored: 42, isDefault: false })).toBe('ask');
    expect(desktopFirstRunAction({ stored: [], isDefault: false })).toBe('ask');
  });
  it('makes / parses the stored record', () => {
    expect(makeDesktopRecord('no', now)).toEqual({ answered: true, answer: 'no', at: '2026-11-02T12:00:00.000Z' });
    expect(parseDesktopRecord({ answered: true, answer: 'weird' })).toEqual({ answered: true, answer: 'no', at: '' });
    expect(parseDesktopRecord(null)).toBeNull();
    expect(parseDesktopRecord({ answer: 'yes' })).toBeNull();
  });
});
