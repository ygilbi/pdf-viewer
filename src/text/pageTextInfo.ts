/**
 * Per-page text facts derived once from the worker's text: detected scale
 * notations and likely element tags. React hook + cache (keyed by doc + local
 * page so removing a file from the workspace never mixes pages up).
 */
import { useEffect, useState } from 'react';
import { getPageText, getWorkspaceClient } from '../core/pdfClient';
import { useViewer } from '../state/store';
import { detectScales, type DetectedScale } from './scaleDetect';
import { detectTags, type TagCount } from './textSearch';

export interface PageTextInfo {
  status: 'loading' | 'ready' | 'error';
  /** Number of text runs on the page (0 = scanned / vector-only drawing). */
  runs: number;
  scales: DetectedScale[];
  tags: TagCount[];
}

const LOADING: PageTextInfo = { status: 'loading', runs: 0, scales: [], tags: [] };
const cache = new Map<string, Promise<PageTextInfo>>();

function keyOf(page: number): string | null {
  const loc = getWorkspaceClient().locate(page);
  return loc ? `${loc.docId}:${loc.localPage}` : null;
}

export function loadPageTextInfo(page: number): Promise<PageTextInfo> {
  const key = keyOf(page);
  if (!key) return Promise.resolve({ ...LOADING, status: 'error' });
  let p = cache.get(key);
  if (!p) {
    p = getPageText(page).then(
      (items) => ({
        status: 'ready' as const,
        runs: items.length,
        scales: detectScales(items, useViewer.getState().pageSizes[page - 1]),
        tags: detectTags(items),
      }),
      () => ({ ...LOADING, status: 'error' as const }),
    );
    cache.set(key, p);
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  }
  return p;
}

/** Text facts for a GLOBAL page (LOADING until the worker answered). */
export function usePageTextInfo(page: number): PageTextInfo {
  const docs = useViewer((s) => s.docs);
  const [state, setState] = useState<{ key: string | null; info: PageTextInfo }>({ key: null, info: LOADING });
  const key = docs.length ? keyOf(page) : null;
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void loadPageTextInfo(page).then((info) => alive && setState({ key, info }));
    return () => {
      alive = false;
    };
  }, [key, page]);
  return state.key === key && key ? state.info : LOADING;
}
