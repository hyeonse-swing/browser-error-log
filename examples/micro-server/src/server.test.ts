// @vitest-environment node
import { request as httpRequest, type Server } from 'node:http';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSampleEvents } from '../../../apps/local-collector/store.ts';
import { readConfig } from './config.ts';
import { createMicroServer } from './server.ts';
import type { MicroConfig, MicroStorage, WriteResult } from './types.ts';

const origin = 'https://client.example';
const event = { ...createSampleEvents()[0], project: 'my-web', eventId: 'id/1' };
const batch = (events: unknown[]) => JSON.stringify({ schemaVersion: 1, events });
const auth = { Authorization: `Basic ${Buffer.from('viewer:local-password').toString('base64')}` };

describe('micro-server configuration', () => {
  it('uses small local defaults and requires explicit external protections', () => {
    expect(readConfig({})).toMatchObject({ host: '127.0.0.1', port: 4319, mode: 'sqlite', projects: ['my-web'], allowedOrigins: [], retentionDays: 7, maxEvents: 10_000, maxDbBytes: 64 * 1024 * 1024, logFileBytes: 8 * 1024 * 1024, logFiles: 3, requestsPerMinute: 120 });
    expect(() => readConfig({ MICRO_HOST: '0.0.0.0' })).toThrow('MICRO_PUBLIC_URL');
    expect(() => readConfig({ MICRO_PUBLIC_URL: 'https://logs.example' })).toThrow('MICRO_VIEWER_PASSWORD');
    expect(() => readConfig({ MICRO_HOST: '0.0.0.0', MICRO_PUBLIC_URL: 'https://logs.example' })).toThrow('MICRO_VIEWER_PASSWORD');
    expect(() => readConfig({ MICRO_HOST: '0.0.0.0', MICRO_PUBLIC_URL: 'https://logs.example', MICRO_VIEWER_PASSWORD: '1234567890123456' })).toThrow('MICRO_PROJECTS');
    expect(readConfig({ MICRO_HOST: '0.0.0.0', MICRO_PUBLIC_URL: 'https://logs.example', MICRO_VIEWER_PASSWORD: '1234567890123456', MICRO_PROJECTS: 'my-web', MICRO_ALLOWED_ORIGINS: origin })).toMatchObject({ publicUrl: 'https://logs.example', allowedOrigins: [origin] });
  });

  it.each([
    { MICRO_ALLOWED_ORIGINS: '*' }, { MICRO_ALLOWED_ORIGINS: 'null' },
    { MICRO_ALLOWED_ORIGINS: 'https://user:pass@client.example' },
    { MICRO_ALLOWED_ORIGINS: 'https://client.example/path' },
    { MICRO_ALLOWED_ORIGINS: 'https://client.example/' },
    { MICRO_PROJECTS: 'my-web,../other' }, { MICRO_PROJECTS: 'my-web,my-web' },
    { MICRO_MAX_EVENTS: '1000001' }, { MICRO_MAX_DB_MB: '2048' },
    { MICRO_REQUESTS_PER_MINUTE: '0' }, { MICRO_LOG_FILES: '999' },
  ])('rejects unsafe setting %j', setting => {
    expect(() => readConfig(setting)).toThrow();
  });
});

describe('micro-server HTTP boundary', () => {
  let folder: string;
  let config: MicroConfig;
  let storage: MicroStorage;
  let server: Server | undefined;
  let base: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'micro-http-'));
    config = { ...readConfig({ MICRO_ALLOWED_ORIGINS: origin, MICRO_VIEWER_PASSWORD: 'local-password' }), publicDir: folder };
    storage = {
      mode: 'sqlite', queryable: true,
      writeBatch: vi.fn(async events => ({ accepted: events.length, stored: events.length, duplicates: 0 })),
      list: vi.fn(() => ({ events: [event] })),
      get: vi.fn(() => event),
      maintain: vi.fn(async () => {}), close: vi.fn(async () => {}),
    };
    await writeFile(join(folder, 'index.html'), '<!doctype html><title>viewer</title>');
    await writeFile(join(folder, 'install.html'), '<!doctype html><title>install</title>');
    await writeFile(join(folder, 'demo.html'), '<!doctype html><title>demo</title>');
    await writeFile(join(folder, 'sdk.js'), 'export const sdk = true;');
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
    await rm(folder, { recursive: true, force: true });
  });

  async function start(): Promise<void> {
    server = createMicroServer(config, storage);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected server address');
    base = `http://127.0.0.1:${address.port}`;
  }

  async function raw(path: string, method = 'GET', headers: Record<string, string> = {}, chunks: string[] = []): Promise<{ status: number; body: string }> {
    const address = server?.address();
    if (!address || typeof address === 'string') throw new Error('Server not started');
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method, headers }, res => {
        const parts: Buffer[] = [];
        res.on('data', chunk => parts.push(Buffer.from(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }));
      });
      req.on('error', reject);
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });
  }

  it('keeps health public, gates reads, and permits an authenticated viewer', async () => {
    await start();
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    const list = await fetch(`${base}/api/events?project=my-web&limit=30`, { headers: auth });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ events: [event] });
    expect(storage.list).toHaveBeenCalledWith({ project: 'my-web', limit: 30 });
    const detail = await fetch(`${base}/api/events/id%2F1?project=my-web`, { headers: auth });
    expect(detail.status).toBe(200);
    expect(storage.get).toHaveBeenCalledWith('my-web', 'id/1');
    expect((await fetch(base, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/install.html`)).status).toBe(401);
    expect((await fetch(`${base}/install.html`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/events`, { headers: { ...auth, Origin: origin } })).status).toBe(403);
  });

  it('accepts a credentialless allowed-origin batch and limits preflight to POST/Content-Type', async () => {
    await start();
    const options = await fetch(`${base}/api/events`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-origin')).toBe(origin);
    expect(options.headers.get('access-control-allow-credentials')).toBeNull();
    const posted = await fetch(`${base}/api/events`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: batch([event]) });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual({ accepted: 1, stored: 1, duplicates: 0 });
    expect(storage.writeBatch).toHaveBeenCalledWith([event]);
    expect((await fetch(`${base}/api/events`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: batch([event]) })).status).toBe(403);
    expect((await fetch(`${base}/api/events`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } })).status).toBe(403);
    expect((await fetch(`${base}/api/events`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } })).status).toBe(403);
  });

  it('rejects invalid batches atomically and reports size/content errors', async () => {
    await start();
    const post = (body: string, contentType = 'application/json') => fetch(`${base}/api/events`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
    expect((await post(batch([event, { ...event, project: 'other' }]))).status).toBe(400);
    expect((await post(batch([{ ...event, occurredAt: 'yesterday' }]))).status).toBe(400);
    expect((await post('{')).status).toBe(400);
    expect((await post(batch([event]), 'text/plain')).status).toBe(415);
    expect((await post('x'.repeat(65_537))).status).toBe(413);
    expect(storage.writeBatch).not.toHaveBeenCalled();
    const streamed = await raw('/api/events', 'POST', { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, ['x'.repeat(40_000), 'x'.repeat(30_000)]);
    expect(streamed.status).toBe(413);
  });

  it('rejects a batch larger than the configured SQLite retention capacity', async () => {
    config.maxEvents = 1;
    await start();
    const response = await fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: batch([event, { ...event, eventId: 'second' }]),
    });
    expect(response.status).toBe(413);
    expect(storage.writeBatch).not.toHaveBeenCalled();
  });

  it('awaits storage and turns write failures into 503', async () => {
    let release!: (value: { accepted: number; stored: number; duplicates: number }) => void;
    storage.writeBatch = vi.fn(() => new Promise<WriteResult>(resolve => { release = resolve; }));
    await start();
    let completed = false;
    const pending = fetch(`${base}/api/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: batch([event]) }).then(response => { completed = true; return response; });
    await vi.waitFor(() => expect(storage.writeBatch).toHaveBeenCalledTimes(1));
    expect(completed).toBe(false);
    release({ accepted: 1, stored: 1, duplicates: 0 });
    expect((await pending).status).toBe(200);
    storage.writeBatch = vi.fn(async () => { throw new Error('private storage detail'); });
    const failed = await fetch(`${base}/api/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: batch([event]) });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private storage detail');
  });

  it('uses one global rate budget and ignores forwarded client addresses', async () => {
    config.requestsPerMinute = 2;
    await start();
    expect((await fetch(`${base}/api/health`, { headers: { 'X-Forwarded-For': '1.1.1.1' } })).status).toBe(200);
    expect((await fetch(`${base}/api/health`, { headers: { 'X-Forwarded-For': '2.2.2.2' } })).status).toBe(200);
    const limited = await fetch(`${base}/api/health`, { headers: { 'X-Forwarded-For': '3.3.3.3' } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('rejects bad Host, traversal, malformed targets, and symlinked assets without crashing', async () => {
    await writeFile(join(folder, 'secret.json'), '{"private":true}');
    await symlink(join(folder, 'secret.json'), join(folder, 'linked.json'));
    await start();
    expect((await raw('/api/health', 'GET', { Host: 'evil.example' })).status).toBe(403);
    expect((await raw('/%2e%2e/secret.json', 'GET', auth)).status).toBe(400);
    expect((await raw('/%GG', 'GET', auth)).status).toBe(400);
    expect((await fetch(`${base}/linked.json`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/.data/secret.json`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('serves logs-only metadata and install assets while disabling list and detail', async () => {
    config.mode = 'jsonl';
    storage = { ...storage, mode: 'jsonl', queryable: false };
    await start();
    expect((await fetch(`${base}/api/events`, { headers: auth })).status).toBe(501);
    expect((await fetch(`${base}/api/events/id?project=my-web`, { headers: auth })).status).toBe(501);
    expect(storage.list).not.toHaveBeenCalled();
    const home = await fetch(base, { headers: auth });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('JSONL log-only mode');
    expect((await fetch(`${base}/index.html`, { headers: auth })).status).toBe(404);
    for (const asset of ['install.html', 'demo.html', 'sdk.js']) expect((await fetch(`${base}/${asset}`, { headers: auth })).status).toBe(200);
  });
});
