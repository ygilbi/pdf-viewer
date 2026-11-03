import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDriveOpenPath, parseDriveState, MAX_DRIVE_FILES } from './driveState';
import { DRIVE_FILES_URL, DriveError, fetchDriveFile, isPdfMeta } from './driveFetch';
import { driveConfigFromProviders, getDriveConfig, resetDriveConfig } from './config';
import { overallPercent } from './driveOpen';

const q = (state: unknown) => `?state=${encodeURIComponent(typeof state === 'string' ? state : JSON.stringify(state))}`;

describe('parseDriveState', () => {
  it('parses an "Open with" launch with resource keys', () => {
    expect(parseDriveState(q({ ids: ['1AbC_d-9', 'XyZ'], action: 'open', userId: '1122334455', resourceKeys: { '1AbC_d-9': '0-key_1' } }))).toEqual({
      action: 'open',
      ids: ['1AbC_d-9', 'XyZ'],
      userId: '1122334455',
      resourceKeys: { '1AbC_d-9': '0-key_1' },
    });
  });
  it('handles "create", double encoding, junk and bad ids', () => {
    expect(parseDriveState(q({ action: 'create', folderId: 'f', userId: '7' }))).toEqual({ action: 'create', userId: '7' });
    expect(parseDriveState(`?state=${encodeURIComponent(encodeURIComponent(JSON.stringify({ ids: ['a'], action: 'open' })))}`)).toMatchObject({ ids: ['a'] });
    expect(parseDriveState('')).toBeNull();
    expect(parseDriveState('?state=%7Bnope')).toBeNull();
    expect(parseDriveState(q({ ids: [], action: 'open' }))).toBeNull();
    expect(parseDriveState(q({ ids: ['a'], action: 'delete' }))).toBeNull();
    expect(parseDriveState(q([1, 2]))).toBeNull();
    const r = parseDriveState(q({ ids: ['ok', '../evil', 'a/b', 5, 'ok'], action: 'open', userId: '<x>', resourceKeys: { ok: 'k', other: 'k2', '../evil': 'k' } }));
    expect(r).toEqual({ action: 'open', ids: ['ok'], userId: null, resourceKeys: { ok: 'k' } });
  });
  it('caps the number of files', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id${i}`);
    expect((parseDriveState(q({ ids, action: 'open' })) as { ids: string[] }).ids).toHaveLength(MAX_DRIVE_FILES);
  });
  it('recognises the Open URL path', () => {
    expect(isDriveOpenPath('/drive/open')).toBe(true);
    expect(isDriveOpenPath('/drive/open/')).toBe(true);
    expect(isDriveOpenPath('/')).toBe(false);
    expect(isDriveOpenPath('/drive/opener')).toBe(false);
  });
});

/** Minimal Drive API mock: metadata + streamed media. */
function driveMock(meta: Record<string, unknown>, bytes: Uint8Array, opts: { mediaStatus?: number; metaStatus?: number; chunk?: number } = {}) {
  const calls: { url: string; headers: Headers }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (!url.includes('alt=media')) {
      return new Response(JSON.stringify(meta), { status: opts.metaStatus ?? 200, headers: { 'Content-Type': 'application/json' } });
    }
    const chunk = opts.chunk ?? 4;
    let off = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (off >= bytes.length) return c.close();
        c.enqueue(bytes.slice(off, off + chunk));
        off += chunk;
      },
    });
    return new Response(body, { status: opts.mediaStatus ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('fetchDriveFile', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7 hello world');

  it('downloads with the bearer token, resource-key header and progress', async () => {
    const { impl, calls } = driveMock({ id: 'F1', name: 'תוכנית.pdf', mimeType: 'application/pdf', size: String(pdf.length) }, pdf);
    const progress: [number, number | null][] = [];
    const file = await fetchDriveFile('F1', { token: 'tok', resourceKey: 'RK', fetchImpl: impl, onProgress: (l, t) => progress.push([l, t]) });
    expect(file.name).toBe('תוכנית.pdf');
    expect(file.type).toBe('application/pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${DRIVE_FILES_URL}/F1?fields=id,name,mimeType,size,resourceKey&supportsAllDrives=true`);
    expect(calls[1].url).toBe(`${DRIVE_FILES_URL}/F1?alt=media&supportsAllDrives=true`);
    for (const c of calls) {
      expect(c.headers.get('authorization')).toBe('Bearer tok');
      expect(c.headers.get('x-goog-drive-resource-keys')).toBe('F1/RK');
    }
    expect(progress[0]).toEqual([0, pdf.length]);
    expect(progress.at(-1)).toEqual([pdf.length, pdf.length]);
    expect(progress.length).toBeGreaterThan(3);
  });

  it('omits the resource-key header when there is none and adds .pdf to the name', async () => {
    const { impl, calls } = driveMock({ name: 'plan', mimeType: 'application/pdf' }, pdf);
    const file = await fetchDriveFile('F2', { token: 't', fetchImpl: impl });
    expect(calls[0].headers.has('x-goog-drive-resource-keys')).toBe(false);
    expect(file.name).toBe('plan.pdf');
  });

  it('rejects non-PDFs before downloading them', async () => {
    const { impl, calls } = driveMock({ name: 'notes.docx', mimeType: 'application/vnd.google-apps.document' }, pdf);
    await expect(fetchDriveFile('F3', { token: 't', fetchImpl: impl })).rejects.toMatchObject({ code: 'not_pdf' });
    expect(calls).toHaveLength(1);
    expect(isPdfMeta({ name: 'x.PDF', mimeType: 'application/octet-stream' })).toBe(true);
    expect(isPdfMeta({ name: 'x.png', mimeType: 'image/png' })).toBe(false);
  });

  it('maps HTTP and network failures to Hebrew DriveErrors', async () => {
    for (const [status, code] of [
      [401, 'auth'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [500, 'failed'],
    ] as const) {
      const { impl } = driveMock({ error: {} }, pdf, { metaStatus: status });
      const err = await fetchDriveFile('F', { token: 't', fetchImpl: impl }).catch((e) => e);
      expect(err).toBeInstanceOf(DriveError);
      expect(err.code).toBe(code);
      expect(err.message).toMatch(/[א-ת]/);
    }
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchDriveFile('F', { token: 't', fetchImpl: offline })).rejects.toMatchObject({ code: 'network' });
  });
});

describe('Drive config from /api/auth/providers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetDriveConfig();
  });
  it('needs a client id; the Picker needs key + project number', () => {
    expect(driveConfigFromProviders({ ok: true, google: false })).toBeNull();
    expect(driveConfigFromProviders(null)).toBeNull();
    expect(driveConfigFromProviders({ googleClientId: 'cid' })).toEqual({ clientId: 'cid', picker: null });
    expect(driveConfigFromProviders({ googleClientId: 'cid', googlePickerApiKey: 'k' })).toEqual({ clientId: 'cid', picker: null });
    expect(driveConfigFromProviders({ googleClientId: 'cid', googlePickerApiKey: 'k', googleAppId: '123' })).toEqual({
      clientId: 'cid',
      picker: { apiKey: 'k', appId: '123' },
    });
  });
  it('is off in the desktop app and fetches once on the web', async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ ok: true, googleClientId: 'cid' }))) as unknown as typeof fetch;
    vi.stubGlobal('window', { pdfDesktop: { isDesktop: true } });
    expect(await getDriveConfig(impl)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
    vi.stubGlobal('window', {});
    expect(await getDriveConfig(impl)).toEqual({ clientId: 'cid', picker: null });
    expect(await getDriveConfig(impl)).toEqual({ clientId: 'cid', picker: null });
    expect(impl).toHaveBeenCalledTimes(1);
  });
});

describe('overallPercent', () => {
  it('combines files and bytes', () => {
    expect(overallPercent(null)).toBeNull();
    expect(overallPercent({ current: 1, count: 1, name: null, loaded: 50, total: 200 })).toBe(25);
    expect(overallPercent({ current: 2, count: 2, name: null, loaded: 100, total: 100 })).toBe(100);
    expect(overallPercent({ current: 2, count: 4, name: null, loaded: 0, total: null })).toBe(25);
    expect(overallPercent({ current: 1, count: 1, name: null, loaded: 10, total: null })).toBeNull();
  });
});
