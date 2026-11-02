/**
 * Prefetched WebAuthn options.
 *
 * iOS Safari only shows Face ID when navigator.credentials.get/create runs inside the click handler
 * (user activation) — an awaited fetch between the click and the call loses it (the sheet never
 * appears, or NotAllowedError). So the options are fetched ahead of time, refreshed before the
 * server challenge (TTL 5 min) expires — every 4 min and when the page becomes visible / focused
 * again — and the click handler only takes them synchronously.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiFailure, ApiResult } from './api';

/** Server challenges live 5 min. */
export const PREFETCH_REFRESH_MS = 4 * 60_000;
/** Never start a ceremony with options older than this (leaves ≥30 s to finish it). */
export const PREFETCH_MAX_AGE_MS = 4.5 * 60_000;

export function isFresh(at: number | null | undefined, now: number, maxAge = PREFETCH_MAX_AGE_MS): boolean {
  return typeof at === 'number' && now - at >= 0 && now - at < maxAge;
}

export interface Prefetched<R> {
  /** Fresh options are waiting (the button can start the ceremony right away). */
  ready: boolean;
  /** Last fetch failed (kept until the next successful one). */
  error: ApiFailure | null;
  /** Last successful answer (also while a refresh runs / after take()). */
  value: R | null;
  /**
   * Synchronous: the fresh options (single use — the challenge is consumed), or null (a refresh is
   * started). After take() automatic refreshes pause until refresh() is called, so a focus /
   * visibility change during the Face ID sheet can't replace the challenge mid-ceremony.
   */
  take(): R | null;
  refresh(): Promise<ApiResult<R> | null>;
}

/**
 * `fetcher` null = disabled. `key` changes → refetch (e.g. the credential ids). `keepFresh` = refresh
 * on a timer / on wake (off: fetch once, e.g. when the options are only used for their extra data).
 */
export function usePrefetch<R extends object>(fetcher: (() => Promise<ApiResult<R>>) | null, key: string, keepFresh = true): Prefetched<R> {
  const slot = useRef<{ value: R; at: number } | null>(null);
  const seq = useRef(0);
  const inflight = useRef(false);
  const held = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [state, setState] = useState<{ ready: boolean; error: ApiFailure | null; value: R | null }>({ ready: false, error: null, value: null });

  const refresh = useCallback(async (): Promise<ApiResult<R> | null> => {
    const f = fetcherRef.current;
    if (!f) return null;
    const my = ++seq.current;
    held.current = false;
    inflight.current = true;
    slot.current = null;
    setState((s) => (s.ready ? { ...s, ready: false } : s));
    const r = await f();
    if (my !== seq.current) return r;
    inflight.current = false;
    if (r.ok) {
      slot.current = { value: r, at: Date.now() };
      setState({ ready: true, error: null, value: r });
    } else {
      setState((s) => ({ ready: false, error: r, value: s.value }));
    }
    return r;
  }, []);

  const enabled = fetcher !== null;
  useEffect(() => {
    if (!enabled) {
      seq.current++;
      inflight.current = false;
      slot.current = null;
      setState({ ready: false, error: null, value: null });
      return;
    }
    void refresh();
    if (!keepFresh) return;
    const stale = () => !isFresh(slot.current?.at, Date.now(), PREFETCH_REFRESH_MS);
    const tick = () => {
      if (!held.current && !inflight.current && stale()) void refresh();
    };
    const timer = window.setInterval(tick, 30_000);
    const wake = () => {
      if (document.visibilityState !== 'hidden') tick();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    return () => {
      seq.current++;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
    };
  }, [enabled, key, keepFresh, refresh]);

  const take = useCallback((): R | null => {
    const s = slot.current;
    if (s && isFresh(s.at, Date.now())) {
      slot.current = null;
      held.current = true;
      setState((st) => ({ ...st, ready: false }));
      return s.value;
    }
    if (!inflight.current) void refresh();
    return null;
  }, [refresh]);

  return { ...state, take, refresh };
}
