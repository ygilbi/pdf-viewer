import { describe, expect, it } from 'vitest';
import { defaultAppSteps, detectBrowser } from './installHelp';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
};

describe('detectBrowser', () => {
  it('detects the install flavour', () => {
    expect(detectBrowser({ userAgent: UA.iphone })).toBe('ios');
    expect(detectBrowser({ userAgent: UA.iphoneChrome })).toBe('ios');
    expect(detectBrowser({ userAgent: UA.ipad, maxTouchPoints: 5 })).toBe('ios');
    expect(detectBrowser({ userAgent: UA.android })).toBe('android');
    expect(detectBrowser({ userAgent: UA.edge })).toBe('chromium-desktop');
    expect(detectBrowser({ userAgent: UA.firefox })).toBe('firefox-desktop');
    expect(detectBrowser({ userAgent: UA.safariMac, maxTouchPoints: 0 })).toBe('safari-mac');
    expect(detectBrowser(undefined)).toBe('other');
  });
});

describe('defaultAppSteps', () => {
  it('has steps for Windows and macOS only', () => {
    expect(defaultAppSteps('windows')?.join(' ')).toContain('אפליקציות ברירת מחדל');
    expect(defaultAppSteps('mac')?.join(' ')).toContain('Change All');
    expect(defaultAppSteps('other')).toBeNull();
  });
});
