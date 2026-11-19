export const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_MAP_BYTES = 8 * 1024 * 1024;

export interface SourceMapManifest {
  schemaVersion: 1;
  project: string;
  environment: string;
  release: string;
  assetUrl: string;
  bundleSha256: string;
  mapSha256: string;
}

// Stack URLs can contain a cache-busting query. Identity always uses the full
// origin and pathname of a deployed asset, never credentials or a basename.
export function canonicalAssetUrl(input: string): string | null {
  if (input.length > 4096 || !/^https?:\/\//i.test(input) || /[\s\\\u0000-\u001f\u007f]/u.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.username || url.password) return null;
    return url.origin + url.pathname;
  } catch { return null; }
}

export function matchesGeneratedFile(declaredFile: unknown, assetUrl: string): boolean {
  if (declaredFile == null) return true;
  if (typeof declaredFile !== 'string' || declaredFile.length > 4096) return false;
  const declared = declaredFile.split(/[\\/]/).at(-1);
  const deployed = new URL(assetUrl).pathname.split('/').at(-1);
  if (!declared || !deployed) return false;
  if (declared === deployed) return true;
  // A bundler may emit a Unicode filename while URL.pathname is percent-encoded.
  try { return declared === decodeURIComponent(deployed); }
  catch { return false; }
}

function label(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64;
}

export function parseSourceMapManifest(input: unknown): SourceMapManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid-manifest');
  const { schemaVersion, project, environment, release, assetUrl, bundleSha256, mapSha256 } = input as Record<string, unknown>;
  if (schemaVersion !== 1 || !label(project, 80) || !project || !label(environment, 80) ||
      !label(release, 120) || !release || release === 'unknown' || !digest(bundleSha256) || !digest(mapSha256)) {
    throw new Error('invalid-manifest');
  }
  const canonicalUrl = typeof assetUrl === 'string' && !/[?#]/.test(assetUrl) ? canonicalAssetUrl(assetUrl) : null;
  if (!canonicalUrl) throw new Error('invalid-manifest');
  return { schemaVersion, project, environment, release, assetUrl: canonicalUrl, bundleSha256, mapSha256 };
}
