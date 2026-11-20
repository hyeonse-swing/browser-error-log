import { MAX_MANIFEST_BYTES, MAX_MAP_BYTES, parseSourceMapManifest, type SourceMapManifest } from './source-map-manifest';
import { prepareSourceMap, sourceMapKey, type MapRegistry } from './source-maps';

type Lookup = Pick<SourceMapManifest, 'project' | 'environment' | 'release' | 'assetUrl'>;
const maxEncodedBytes = 4 * Math.ceil(MAX_MAP_BYTES / 3);
const maxResponseBytes = maxEncodedBytes + MAX_MANIFEST_BYTES + 2048;

async function readPayload(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing registry response');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw new Error('Oversized registry response');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchRegisteredMap(lookup: Lookup, signal: AbortSignal) {
  const response = await fetch('/api/source-maps?' + new URLSearchParams(lookup), {
    mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Registry read failed');
  const payload = await readPayload(response);
  const manifest = parseSourceMapManifest(payload?.manifest);
  if (sourceMapKey(manifest) !== sourceMapKey(lookup)) throw new Error('Unexpected registration');
  const encoded = payload.mapBase64;
  if (typeof encoded !== 'string' || !encoded || encoded.length > maxEncodedBytes) throw new Error('Invalid map bytes');
  const decoded = atob(encoded);
  if (decoded.length > MAX_MAP_BYTES) throw new Error('Oversized map');
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return prepareSourceMap(new File([JSON.stringify(manifest)], 'manifest.json'), new File([bytes], 'registered.map'));
}

// Each registry already enforces its own byte and segment budgets. Share the
// prepared entries so merging the current event never duplicates their contents.
export function combineRegistries(local: MapRegistry, remote: MapRegistry): MapRegistry {
  if (!remote.entries.size) return local;
  const entries = new Map(local.entries);
  const conflicts = new Set(local.conflicts);
  for (const [key, map] of remote.entries) {
    const previous = entries.get(key);
    if (previous && (previous.bundleSha256 !== map.bundleSha256 || previous.mapSha256 !== map.mapSha256)) {
      conflicts.add(key);
    } else {
      entries.set(key, map);
    }
  }
  return { entries, conflicts };
}
