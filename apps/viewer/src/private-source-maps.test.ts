// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { combineRegistries, fetchRegisteredMap } from './private-source-maps';
import { emptySourceMaps, registerSourceMap } from './source-maps';

const lookup = { project: 'my-web', environment: 'test', release: 'release-A', assetUrl: 'https://cdn.example/app.js' };
const bytes = Buffer.from(JSON.stringify({ version: 3, sources: ['cart.tsx'], sourcesContent: ['throw error;'], names: [], mappings: 'AAAA' }));
const manifest = { schemaVersion: 1, ...lookup, bundleSha256: 'a'.repeat(64), mapSha256: createHash('sha256').update(bytes).digest('hex') };
const payload = { manifest, mapBase64: bytes.toString('base64') };
const signal = new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

it('fetches only from the same collector and verifies the requested scope and content hash', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(payload))
    .mockResolvedValueOnce(Response.json({ ...payload, manifest: { ...manifest, release: 'release-B' } }))
    .mockResolvedValueOnce(Response.json({ ...payload, mapBase64: Buffer.from('different bytes').toString('base64') }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  const map = await fetchRegisteredMap(lookup, signal);
  expect(map?.sourceContents?.get(0)).toBe('throw error;');
  expect(fetcher.mock.calls[0]).toEqual(['/api/source-maps?' + new URLSearchParams(lookup), {
    mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
  }]);
  await expect(fetchRegisteredMap(lookup, signal)).rejects.toThrow('Unexpected registration');
  await expect(fetchRegisteredMap(lookup, signal)).rejects.toThrow('map-hash-mismatch');
  await expect(fetchRegisteredMap(lookup, signal)).resolves.toBeNull();
  await expect(fetchRegisteredMap(lookup, signal)).rejects.toThrow('Registry read failed');
});

it('disables a conflicting local and CI registration without changing either registry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
  const map = (await fetchRegisteredMap(lookup, signal))!;
  const remote = registerSourceMap(emptySourceMaps(), map);
  const local = registerSourceMap(emptySourceMaps(), { ...map, bundleSha256: 'b'.repeat(64) });
  expect(combineRegistries(remote, remote).conflicts.size).toBe(0);
  expect(combineRegistries(local, remote).conflicts.has(map.key)).toBe(true);
  expect(remote.conflicts.size + local.conflicts.size).toBe(0);
});
