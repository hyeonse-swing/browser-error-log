// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createSampleEvents } from './store.ts';
import { allowedOrigins, collectorPort, createStandaloneCollectorServer } from './server.ts';
import { request, type Server } from 'node:http';
import { createConnection } from 'node:net';

let server: Server | undefined;
let base = '';
async function start(origins: string[] = []) {
  server = createStandaloneCollectorServer(origins);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server!.once('error', onError);
    server!.listen(0, '127.0.0.1', () => { server!.off('error', onError); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  base = `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

const batch = (events: unknown[]) => JSON.stringify({ schemaVersion: 1, events });
const post = (body: string, headers: Record<string, string> = {}) => fetch(`${base}/api/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

describe('standalone collector HTTP', () => {
  it('returns a controlled error for a malformed request target and stays healthy', async () => {
    await start();
    const address = server!.address();
    if (!address || typeof address === 'string') throw new Error('No TCP address');
    const response = await new Promise<string>((resolve, reject) => {
      let data = '';
      const socket = createConnection(address.port, '127.0.0.1');
      socket.on('connect', () => socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\n\r\n`));
      socket.on('data', chunk => { data += chunk.toString(); });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(response).toContain('Invalid request');
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
  it('starts empty, accepts events, deduplicates retries, and reads details', async () => {
    await start();
    expect((await (await fetch(`${base}/api/events`)).json()).events).toEqual([]);
    const event = { ...createSampleEvents()[0], eventId: 'id/1', project: 'private-project' };
    expect(await (await post(batch([event]))).json()).toEqual({ accepted: 1, stored: 1, duplicates: 0 });
    expect(await (await post(batch([{ ...event, message: 'retry' }]))).json()).toEqual({ accepted: 1, stored: 0, duplicates: 1 });
    const detail = await fetch(`${base}/api/events/id%2F1?project=private-project`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).message).toBe(event.message);
    expect((await (await fetch(`${base}/api/events?project=private-project`)).json()).events).toHaveLength(1);
    expect((await (await fetch(`${base}/api/health`)).json()).durable).toBe(false);
    expect((await fetch(`${base}/api/reset`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/seed`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/demo-api/failure`)).status).toBe(404);
  });

  it('rejects malformed and oversized batches atomically with controlled errors', async () => {
    await start();
    const event = createSampleEvents()[0];
    const compact = { ...event, stack: undefined, context: undefined, browser: undefined };
    for (const body of ['null', '{broken', batch([event, { ...event, message: { untrusted: 'secret' } }]), batch(Array.from({ length: 101 }, (_, i) => ({ ...compact, eventId: `event-${i}` })))]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain('secret');
    }
    const large = await post(batch([{ ...event, message: 'x'.repeat(65536) }]));
    expect(large.status).toBe(413);
    expect((await (await fetch(`${base}/api/events`)).json()).events).toEqual([]);
    expect((await post(batch([event]), { 'Content-Type': 'text/plain' })).status).toBe(415);
    const cursor = await fetch(`${base}/api/events?cursor=invalid`);
    expect(cursor.status).toBe(400);
    expect(await cursor.json()).toEqual({ error: 'Invalid request' });
  });

  it('allows exact origins and matching preflight, rejects other origins before mutation', async () => {
    await start(['https://app.example']);
    const origin = 'https://app.example';
    const options = await fetch(`${base}/api/events`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(options.status).toBe(204);
    expect(options.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(options.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    const getOptions = await fetch(`${base}/api/health`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:4317', 'Access-Control-Request-Method': 'GET' } });
    expect(getOptions.status).toBe(204);
    expect(getOptions.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4317');
    expect((await fetch(`${base}/api/events`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'DELETE' } })).status).toBe(403);
    expect((await fetch(`${base}/api/events`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } })).status).toBe(403);
    const event = createSampleEvents()[0];
    const denied = await post(batch([event]), { Origin: 'https://other.example' });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await (await fetch(`${base}/api/events`)).json()).events).toEqual([]);
    expect((await post(batch([event]), { Origin: origin })).headers.get('Access-Control-Allow-Origin')).toBe(origin);
  });

  it('rejects non-loopback Host and validates environment configuration', async () => {
    await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/health`, { headers: { Host: 'evil.example:4318' } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(403);
    expect(collectorPort(undefined)).toBe(4318);
    for (const value of ['0', '-1', '65536', '4318x']) expect(() => collectorPort(value)).toThrow();
    expect(allowedOrigins('https://app.example,http://localhost:5000')).toEqual(['https://app.example', 'http://localhost:5000']);
    for (const value of ['', '*', 'null', 'https://*.example.com', 'https://app.example/path', 'https://user@app.example', 'ftp://app.example', 'http://a,']) expect(() => allowedOrigins(value)).toThrow();
  });
});
