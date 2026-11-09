import { describe, expect, it } from 'vitest';
import { allPages, ensurePdfExtension, saveAsPdfOptions, suggestSaveAsName } from './saveAsName';
import { DEFAULT_PDF_OPTIONS } from './types';

describe('suggestSaveAsName', () => {
  it('appends -marked to the first file name', () => {
    expect(suggestSaveAsName(['קומה 1.pdf'])).toBe('קומה 1-marked.pdf');
    expect(suggestSaveAsName(['plan.PDF', 'other.pdf'])).toBe('plan-marked.pdf');
  });
  it('strips folders and characters file systems refuse', () => {
    expect(suggestSaveAsName(['C:\\docs\\a:b?.pdf'])).toBe('a_b_-marked.pdf');
    expect(suggestSaveAsName(['x/y/z.pdf'])).toBe('z-marked.pdf');
  });
  it('never returns an empty name and does not stack the suffix', () => {
    expect(suggestSaveAsName([])).toBe('document-marked.pdf');
    expect(suggestSaveAsName([null, '  ', undefined])).toBe('document-marked.pdf');
    expect(suggestSaveAsName(['.pdf'])).toBe('document-marked.pdf');
    expect(suggestSaveAsName(['plan-marked.pdf'])).toBe('plan-marked.pdf');
  });
  it('keeps names without the .pdf extension', () => {
    expect(suggestSaveAsName(['scan'])).toBe('scan-marked.pdf');
  });
});

describe('save-as helpers', () => {
  it('adds .pdf when missing', () => {
    expect(ensurePdfExtension('a')).toBe('a.pdf');
    expect(ensurePdfExtension('a.PDF')).toBe('a.PDF');
  });
  it('uses the export defaults, items table only when there are items', () => {
    expect(saveAsPdfOptions(true)).toEqual(DEFAULT_PDF_OPTIONS);
    expect(saveAsPdfOptions(false)).toEqual({ ...DEFAULT_PDF_OPTIONS, items: false });
    expect(saveAsPdfOptions(false).markup).toBe(true); // text edits / signatures are markup
  });
  it('lists every page', () => {
    expect(allPages(3)).toEqual([1, 2, 3]);
    expect(allPages(0)).toEqual([]);
  });
});
