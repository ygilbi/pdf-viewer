import { beforeEach, describe, expect, it } from 'vitest';
import { LAB_DEFAULTS, labSummary, useLab } from './lab';

describe('crash lab flags', () => {
  beforeEach(() => useLab.getState().reset());
  it('are all off by default and summarised for reports', () => {
    expect(labSummary()).toBe('');
    useLab.getState().setFlag('noLinkText', true);
    useLab.getState().setFlag('hideOverlayOnPinch', true);
    expect(labSummary()).toBe('hideOverlayOnPinch,noLinkText');
    useLab.getState().reset();
    expect(labSummary()).toBe('');
    for (const v of Object.values(LAB_DEFAULTS)) expect(v).toBe(false);
  });
});
