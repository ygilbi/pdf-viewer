/**
 * /welcome install guidance — pure logic (no DOM at import time; unit-tested).
 *
 * Chromium browsers fire `beforeinstallprompt` and get a real "install" button; everyone
 * else (Safari / iOS / Firefox, or Chromium before the event arrives) gets short manual
 * steps for their browser.
 */
import type { Os } from '../pwa/defaultApp';

export type Browser =
  /** iPhone / iPad (any browser: all use WebKit's "Add to Home Screen"). */
  | 'ios'
  | 'android'
  /** Chrome / Edge / other Chromium on a desktop OS. */
  | 'chromium-desktop'
  | 'firefox-desktop'
  | 'safari-mac'
  | 'other';

interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
}

export function detectBrowser(nav: NavigatorLike | undefined): Browser {
  const ua = nav?.userAgent ?? '';
  const touch = (nav?.maxTouchPoints ?? 0) > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touch)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Firefox\//i.test(ua)) return 'firefox-desktop';
  if (/Edg\/|Chrome\/|Chromium\//i.test(ua)) return 'chromium-desktop';
  if (/Macintosh/i.test(ua) && /Safari\//i.test(ua)) return 'safari-mac';
  return 'other';
}

/** One-line manual install instructions (no `beforeinstallprompt`). */
export const INSTALL_STEPS: Record<Browser, string> = {
  ios: 'ב-Safari: הקש/י על כפתור השיתוף (ריבוע עם חץ למעלה) ← "הוסף למסך הבית".',
  android: 'בתפריט ⋮ של הדפדפן בחר/י "התקנת אפליקציה" או "הוספה למסך הבית".',
  'chromium-desktop': 'ב-Chrome / Edge: לחץ/י על סמל ההתקנה בצד שורת הכתובת (מסך עם חץ) ← "התקן". אפשר גם מתפריט ⋮ ← "התקנת PDF Viewer".',
  'firefox-desktop': 'Firefox אינו מתקין אפליקציות אתר במחשב. פתח/י את הדף הזה ב-Chrome או ב-Edge כדי להתקין.',
  'safari-mac': 'ב-Safari: תפריט "קובץ" ← "הוסף ל-Dock".',
  other: 'פתח/י את הדף ב-Chrome או ב-Edge ובחר/י "התקן" ליד שורת הכתובת.',
};

/** "Set as default PDF app" steps after installing (null: the OS has no such flow for web apps). */
export function defaultAppSteps(os: Os): string[] | null {
  if (os === 'windows')
    return [
      'פתח/י את הגדרות Windows ← אפליקציות ← אפליקציות ברירת מחדל.',
      'חפש/י ‎.pdf‎ ובחר/י PDF Viewer.',
      'או: לחיצה ימנית על קובץ PDF ← "פתח באמצעות" ← "בחר אפליקציה אחרת" ← PDF Viewer ← "תמיד".',
    ];
  if (os === 'mac')
    return [
      'ב-Finder: לחיצה ימנית על קובץ PDF ← "הצג מידע" (Get Info).',
      'תחת "פתח באמצעות" בחר/י PDF Viewer.',
      'לחץ/י "שנה הכל…" (Change All) ואשר/י.',
    ];
  return null;
}
