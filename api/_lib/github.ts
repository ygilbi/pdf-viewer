// Resolve the newest Windows installer in the (private) GitHub repo to a short-lived signed download URL.
// The function never streams the ~120 MB file itself: it redirects the browser to GitHub's signed URL.

export const TAG_PREFIX = 'desktop-v';
export const ASSET_PATTERN = /^PDF-Viewer-Setup-.*\.exe$/;

interface GhAsset {
  id: number;
  name: string;
}
interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
  assets: GhAsset[];
}

export class GitHubError extends Error {}

function ghHeaders(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pdf-viewer-download-approval',
  };
}

/** Pick the newest published, non-draft desktop-v* release that has a matching installer asset. */
export function pickInstaller(releases: GhRelease[]): { tag: string; asset: GhAsset } | null {
  const candidates = releases
    .filter((r) => !r.draft && r.tag_name.startsWith(TAG_PREFIX))
    .sort((a, b) => {
      // Stable releases before pre-releases, then newest first.
      if (a.prerelease !== b.prerelease) return a.prerelease ? 1 : -1;
      return Date.parse(b.published_at ?? b.created_at) - Date.parse(a.published_at ?? a.created_at);
    });
  for (const r of candidates) {
    const asset = r.assets.find((a) => ASSET_PATTERN.test(a.name));
    if (asset) return { tag: r.tag_name, asset };
  }
  return null;
}

export async function resolveInstallerUrl(
  repo: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; tag: string; assetName: string }> {
  const base = `https://api.github.com/repos/${repo}`;
  const listRes = await fetchImpl(`${base}/releases?per_page=50`, {
    headers: ghHeaders(token, 'application/vnd.github+json'),
  });
  if (!listRes.ok) throw new GitHubError(`list releases failed: HTTP ${listRes.status}`);
  const releases = (await listRes.json()) as GhRelease[];
  const picked = pickInstaller(Array.isArray(releases) ? releases : []);
  if (!picked) throw new GitHubError('no desktop-v* release with a PDF-Viewer-Setup-*.exe asset');

  const assetRes = await fetchImpl(`${base}/releases/assets/${picked.asset.id}`, {
    headers: ghHeaders(token, 'application/octet-stream'),
    redirect: 'manual',
  });
  const location = assetRes.headers.get('location');
  if (assetRes.status >= 300 && assetRes.status < 400 && location) {
    // Do not read the body; release the connection.
    await assetRes.body?.cancel().catch(() => {});
    return { url: location, tag: picked.tag, assetName: picked.asset.name };
  }
  await assetRes.body?.cancel().catch(() => {});
  throw new GitHubError(`asset request did not redirect: HTTP ${assetRes.status}`);
}
