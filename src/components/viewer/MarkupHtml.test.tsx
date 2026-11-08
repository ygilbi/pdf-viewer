import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AreaMeasurement } from '../../core/types';

// SSR cannot render portals: render the portaled phone card in place.
vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (n: unknown) => n }));

const link: AreaMeasurement = {
  id: 'l1',
  page: 1,
  kind: 'link',
  label: 'קישור 1',
  points: [{ x: 10, y: 10 }, { x: 60, y: 40 }],
  targetPage: 2,
  text: '1',
} as AreaMeasurement;

describe('LinkEditor on phones', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not let its full-width centring strip swallow touches (pinch over it must reach the viewer)', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse') }));
    vi.stubGlobal('document', { body: {} });
    const { MarkupEditor } = await import('./MarkupHtml');
    const html = renderToStaticMarkup(<MarkupEditor m={link} />);
    // Outer fixed strip spans the screen width → no hit testing; only the card takes touches,
    // and never as a native page pinch / scroll.
    expect(html).toMatch(/^<div data-viewer-ui="true" class="fixed inset-x-0[^"]*" style="z-index:60;pointer-events:none"/);
    expect(html).toMatch(/<div dir="rtl" class="w-60[^"]*" style="[^"]*pointer-events:auto;touch-action:none"/);
  });
});
