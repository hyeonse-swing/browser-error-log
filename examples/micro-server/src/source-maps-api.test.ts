// @vitest-environment node
import { createHash } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceMapManifest } from '../../../apps/viewer/src/source-map-manifest.ts';
import { readConfig } from './config.ts';
import { createMicroServer } from './server.ts';
import { createStorage } from './storage.ts';
import type { MicroConfig, MicroStorage } from './types.ts';

const token = 'source-map-token-that-is-longer-than-32-characters';
const viewer = { Authorization: `Basic ${Buffer.from('viewer:local-password').toString('base64')}` };
const bearer = { Authorization: `Bearer ${token}` };
const map = JSON.stringify({ version: 3, file: 'app.js', sources: ['src/app.ts'], names: [],
  mappings: 'AAAA', sourcesContent: ['export const answer = 42;\n'] });
const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');
const manifest = (release = 'v1', mapText = map): SourceMapManifest => ({
  schemaVersion: 1, project: 'my-web', environment: 'production', release,
  assetUrl: 'https://cdn.example/app.js', bundleSha256: sha256('bundle'), mapSha256: sha256(mapText),
});
const upload = (release = 'v1', mapText = map): string => JSON.stringify({
  manifest: manifest(release, mapText), mapBase64: Buffer.from(mapText).toString('base64'),
});

describe('private micro-server source map registry', () => {
  let folder: string;
  let config: MicroConfig;
  let storage: MicroStorage;
  let server: Server | undefined;
  let base: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'micro-source-maps-'));
    config = readConfig({ MICRO_SOURCE_MAP_TOKEN: token, MICRO_VIEWER_PASSWORD: 'local-password',
      MICRO_PROJECTS: 'my-web', MICRO_DATA_DIR: join(folder, 'data'), MICRO_PUBLIC_DIR: join(folder, 'public') });
    storage = await createStorage(config.mode, config);
    server = createMicroServer(config, storage);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected server address');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await storage.close();
    await rm(folder, { recursive: true, force: true });
  });

  const query = (release = 'v1', assetUrl = 'https://cdn.example/app.js'): string =>
    new URLSearchParams({ project: 'my-web', environment: 'production', release, assetUrl }).toString();

  function post(body = upload(), headers: Record<string, string> = bearer): Promise<Response> {
    return fetch(`${base}/api/source-maps`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body });
  }

  async function restart(): Promise<void> {
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await storage.close();
    storage = await createStorage(config.mode, config);
    server = createMicroServer(config, storage);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected server address');
    base = `http://127.0.0.1:${address.port}`;
  }

  it('requires secure opt-in configuration and keeps unconfigured endpoints closed', async () => {
    expect(() => readConfig({ MICRO_SOURCE_MAP_TOKEN: 'short', MICRO_VIEWER_PASSWORD: 'local-password' })).toThrow('MICRO_SOURCE_MAP_TOKEN');
    expect(() => readConfig({ MICRO_SOURCE_MAP_TOKEN: token })).toThrow('MICRO_VIEWER_PASSWORD');
    expect(() => readConfig({ MICRO_SOURCE_MAP_TOKEN: token, MICRO_VIEWER_PASSWORD: 'local-password', MICRO_STORAGE: 'jsonl' })).toThrow('sqlite');
    expect(() => readConfig({ MICRO_SOURCE_MAP_TOKEN: token, MICRO_VIEWER_PASSWORD: 'local-password',
      MICRO_DATA_DIR: join(folder, 'public', 'data'), MICRO_PUBLIC_DIR: join(folder, 'public') })).toThrow('outside');
    expect(readConfig({ MICRO_SOURCE_MAP_TOKEN: '' }).sourceMapToken).toBeUndefined();
    config.sourceMapToken = undefined;
    expect((await post()).status).toBe(404);
    expect((await fetch(`${base}/api/source-maps?${query()}`, { headers: viewer })).status).toBe(404);
    const script = await fetch(`${base}/api/viewer-config.js`, { headers: viewer });
    expect(await script.text()).toContain('"sourceMapRegistry":false');
    const disabledConfig = readConfig({ MICRO_VIEWER_PASSWORD: 'local-password',
      MICRO_DATA_DIR: join(folder, 'disabled'), MICRO_PUBLIC_DIR: join(folder, 'public') });
    const disabledStorage = await createStorage(disabledConfig.mode, disabledConfig);
    try {
      expect(disabledStorage.sourceMapRegistry).toBe(false);
      await expect(access(join(folder, 'disabled', 'source-maps.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await disabledStorage.close(); }
  });

  it('registers an exact release key, serves the original bytes to the viewer, and survives restart', async () => {
    expect((await post(upload(), {})).status).toBe(401);
    expect((await post(upload(), { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(upload(), { ...bearer, Origin: 'https://client.example' })).status).toBe(403);
    const created = await post();
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ status: 'created' });
    const eventDb = new DatabaseSync(join(folder, 'data', 'events.sqlite'));
    const mapDb = new DatabaseSync(join(folder, 'data', 'source-maps.sqlite'));
    try {
      expect(eventDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_maps'").get()).toBeUndefined();
      expect(mapDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_maps'").get()).toMatchObject({ name: 'source_maps' });
    } finally { eventDb.close(); mapDb.close(); }
    expect((await fetch(`${base}/api/source-maps?${query()}`)).status).toBe(401);
    const fetched = await fetch(`${base}/api/source-maps?${query('v1', 'https://cdn.example/app.js?v=2')}`, { headers: viewer });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('cache-control')).toBe('no-store');
    expect(await fetched.json()).toEqual({ manifest: manifest(), mapBase64: Buffer.from(map).toString('base64') });
    expect((await fetch(`${base}/api/source-maps?${query('v2')}`, { headers: viewer })).status).toBe(404);
    expect((await fetch(`${base}/api/source-maps?${query('v1', 'https://other.example/app.js')}`, { headers: viewer })).status).toBe(404);
    const script = await fetch(`${base}/api/viewer-config.js`, { headers: viewer });
    expect(script.headers.get('content-type')).toContain('application/javascript');
    expect(script.headers.get('cache-control')).toBe('no-store');
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    const scriptText = await script.text();
    expect(scriptText).toContain('"sourceMapRegistry":true');
    expect(scriptText).not.toContain(token);
    await restart();
    const afterRestart = await fetch(`${base}/api/source-maps?${query()}`, { headers: viewer });
    expect(await afterRestart.json()).toEqual({ manifest: manifest(), mapBase64: Buffer.from(map).toString('base64') });
  });

  it('keeps the first valid map when retries, conflicts, and invalid uploads arrive', async () => {
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(200);
    const changed = map.replace('42', '43');
    expect((await post(upload('v1', changed))).status).toBe(409);
    const changedBundle = JSON.stringify({ manifest: { ...manifest(), bundleSha256: sha256('other bundle') },
      mapBase64: Buffer.from(map).toString('base64') });
    expect((await post(changedBundle)).status).toBe(409);
    const badHash = JSON.stringify({ manifest: { ...manifest('v2'), mapSha256: sha256('wrong') },
      mapBase64: Buffer.from(map).toString('base64') });
    expect((await post(badHash)).status).toBe(400);
    const unsupported = JSON.stringify({ version: 3, file: 'app.js', sections: [] });
    expect((await post(upload('v2', unsupported))).status).toBe(400);
    expect((await post(JSON.stringify({ manifest: { ...manifest('v2'), project: 'other' },
      mapBase64: Buffer.from(map).toString('base64') }))).status).toBe(400);
    expect((await post(JSON.stringify({ manifest: manifest('v2'), mapBase64: 'ab==' }))).status).toBe(400);
    const oversized = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/api/source-maps`, { method: 'POST', headers: {
        ...bearer, 'Content-Type': 'application/json', 'Content-Length': 12 * 1024 * 1024,
      } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', reject);
      request.end();
    });
    expect(oversized).toBe(413);
    const fetched = await fetch(`${base}/api/source-maps?${query()}`, { headers: viewer });
    expect(await fetched.json()).toEqual({ manifest: manifest(), mapBase64: Buffer.from(map).toString('base64') });
    expect((await fetch(`${base}/api/source-maps?${query()}&extra=1`, { headers: viewer })).status).toBe(400);
    expect((await fetch(`${base}/api/source-maps?${query()}`, { headers: { ...viewer, Origin: 'https://client.example' } })).status).toBe(403);
  });

  it('serializes concurrent registrations and enforces the registry entry cap', async () => {
    const changed = map.replace('42', '43');
    const results = await Promise.all([post(upload()), post(upload('v1', changed))]);
    expect(results.map(response => response.status).sort()).toEqual([201, 409]);
    for (let number = 2; number <= 32; number++) {
      expect((await post(upload(`v${number}`))).status).toBe(201);
    }
    expect((await post(upload('v33'))).status).toBe(507);
    expect((await post(upload())).status).toBe(results[0].status === 201 ? 200 : 409);
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await storage.close();
    const registry = new DatabaseSync(join(folder, 'data', 'source-maps.sqlite'));
    try {
      const deleted = registry.prepare(`DELETE FROM source_maps
        WHERE project = ? AND environment = ? AND release = ?`).run('my-web', 'production', 'v2');
      expect(deleted.changes).toBe(1);
    } finally { registry.close(); }
    storage = await createStorage(config.mode, config);
    server = createMicroServer(config, storage);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected server address');
    base = `http://127.0.0.1:${address.port}`;
    expect((await post(upload('v33'))).status).toBe(201);
    expect((await fetch(`${base}/api/source-maps?${query('v2')}`, { headers: viewer })).status).toBe(404);
  });
});
