import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { EventFilter, EventType } from 'browser-error-log-protocol';
import { isEventRecord } from '../../../apps/local-collector/store.ts';
import type { MicroConfig, MicroStorage } from './types.ts';

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const DETAIL_PREFIX = '/api/events/';
const EVENT_TYPES = new Set<EventType>(['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual']);
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

function basicAuthorized(header: string | undefined, password: string): boolean {
  if (!header || header.length > 1024 || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header)) return false;
  const encoded = header.slice(6);
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) return false;
  const expected = createHash('sha256').update(`viewer:${password}`).digest();
  const actual = createHash('sha256').update(decoded).digest();
  return timingSafeEqual(actual, expected);
}

function requireViewer(req: IncomingMessage, res: ServerResponse, password: string | undefined): boolean {
  if (password === undefined || basicAuthorized(req.headers.authorization, password)) return true;
  res.setHeader('WWW-Authenticate', 'Basic realm="micro-server", charset="UTF-8"');
  json(res, 401, { error: 'Viewer authentication required' });
  return false;
}

function ownOrigins(config: MicroConfig, port: number): Set<string> {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (config.publicUrl) origins.add(config.publicUrl);
  return origins;
}

function validHost(req: IncomingMessage, config: MicroConfig, port: number): boolean {
  const host = req.headers.host;
  return typeof host === 'string' && (host === `127.0.0.1:${port}` || host === `localhost:${port}` || (config.publicUrl !== undefined && host === new URL(config.publicUrl).host));
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  return new Promise(resolveBody => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    let finished = false;
    const timer = setTimeout(() => fail(408, 'Request timed out'), BODY_TIMEOUT_MS);
    function finish(body: Buffer | null): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      resolveBody(body);
    }
    function fail(status: number, message: string): void {
      if (finished) return;
      req.pause();
      res.setHeader('Connection', 'close');
      json(res, status, { error: message });
      finish(null);
    }
    function onData(chunk: Buffer | string): void {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > MAX_BODY_BYTES) return fail(413, 'Batch exceeds 64 KiB');
      chunks.push(data);
    }
    function onEnd(): void { finish(Buffer.concat(chunks, bytes)); }
    function onError(): void { finish(null); }
    function onAborted(): void { finish(null); }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function boundedParam(url: URL, key: string, maxLength: number): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1 || (values[0] !== undefined && values[0].length > maxLength)) throw new Error('Invalid request');
  return values[0];
}

function listFilter(url: URL): EventFilter {
  const allowed = new Set(['project', 'environment', 'type', 'query', 'from', 'to', 'cursor', 'limit']);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key))) throw new Error('Invalid request');
  const project = boundedParam(url, 'project', 64);
  const environment = boundedParam(url, 'environment', 128);
  const type = boundedParam(url, 'type', 32);
  const query = boundedParam(url, 'query', 256);
  const from = boundedParam(url, 'from', 64);
  const to = boundedParam(url, 'to', 64);
  const cursor = boundedParam(url, 'cursor', 1024);
  const limit = boundedParam(url, 'limit', 3);
  if ((type && !EVENT_TYPES.has(type as EventType)) ||
      (from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to))) ||
      (from && to && Date.parse(from) > Date.parse(to)) ||
      (cursor !== undefined && (!cursor || !/^[A-Za-z0-9_-]+$/.test(cursor))) ||
      (limit !== undefined && !/^(?:[1-9]|[1-9]\d|100)$/.test(limit))) throw new Error('Invalid request');
  return {
    ...(project ? { project } : {}), ...(environment ? { environment } : {}),
    ...(type ? { type: type as EventType } : {}), ...(query ? { query } : {}),
    ...(from ? { from } : {}), ...(to ? { to } : {}),
    ...(cursor ? { cursor } : {}), ...(limit ? { limit: Number(limit) } : {}),
  };
}

async function staticFile(res: ServerResponse, config: MicroConfig, rawPath: string): Promise<void> {
  if (/%2f|%5c/i.test(rawPath)) return json(res, 404, { error: 'Not found' });
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath === '/' ? '/index.html' : rawPath); }
  catch { return json(res, 400, { error: 'Invalid request' }); }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || decoded.includes('\0')) return json(res, 404, { error: 'Not found' });
  const parts = decoded.slice(1).split('/');
  if (parts.some(part => !part || part.startsWith('.') || part === '..')) return json(res, 404, { error: 'Not found' });
  if (config.mode === 'jsonl' && !['install.html', 'demo.html', 'sdk.js'].includes(parts.join('/'))) {
    return json(res, 404, { error: 'Not found' });
  }
  const mime = MIME_TYPES[extname(parts.at(-1)!)];
  if (!mime) return json(res, 404, { error: 'Not found' });
  const root = resolve(config.publicDir);
  const file = resolve(root, ...parts);
  if (!file.startsWith(root + sep)) return json(res, 404, { error: 'Not found' });
  try {
    let current = root;
    if ((await lstat(current)).isSymbolicLink()) return json(res, 404, { error: 'Not found' });
    for (const part of parts) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) return json(res, 404, { error: 'Not found' });
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) return json(res, 404, { error: 'Not found' });
      const content = await handle.readFile();
      res.statusCode = 200;
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(content);
    } finally { await handle.close(); }
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

export function createMicroServer(config: MicroConfig, storage: MicroStorage): Server {
  let windowStart = Date.now();
  let requests = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const now = Date.now();
      if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
      if (++requests > config.requestsPerMinute) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((60_000 - (now - windowStart)) / 1000))));
        return json(res, 429, { error: 'Rate limit exceeded' });
      }
      const address = server.address();
      const port = address && typeof address !== 'string' ? address.port : config.port;
      if (!validHost(req, config, port)) return json(res, 403, { error: 'Host not allowed' });
      const target = req.url ?? '';
      if (!target.startsWith('/') || target.startsWith('//') || target.length > 8192) return json(res, 400, { error: 'Invalid request' });
      try {
        if (target.split('?')[0].split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))) return json(res, 400, { error: 'Invalid request' });
      } catch { return json(res, 400, { error: 'Invalid request' }); }
      let url: URL;
      try { url = new URL(target, `http://127.0.0.1:${port}`); }
      catch { return json(res, 400, { error: 'Invalid request' }); }
      const pathname = url.pathname;
      const origin = req.headers.origin;
      const own = ownOrigins(config, port);
      const allowed = new Set([...own, ...config.allowedOrigins]);
      if (origin && !allowed.has(origin)) return json(res, 403, { error: 'Origin not allowed' });
      if (req.method === 'OPTIONS') {
        const headers = req.headers['access-control-request-headers'];
        const requested = typeof headers === 'string' ? headers.toLowerCase().split(',').map(value => value.trim()) : [];
        if (pathname !== '/api/events' || !origin || req.headers['access-control-request-method'] !== 'POST' || requested.some(value => value !== 'content-type')) {
          return json(res, 403, { error: 'Preflight not allowed' });
        }
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
        res.setHeader('Cache-Control', 'no-store');
        res.end();
        return;
      }
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (pathname === '/api/events' && req.method === 'POST') {
        if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'application/json required' });
        const declaredLength = req.headers['content-length'];
        if (declaredLength !== undefined && Number(declaredLength) > MAX_BODY_BYTES) {
          res.setHeader('Connection', 'close');
          return json(res, 413, { error: 'Batch exceeds 64 KiB' });
        }
        const body = await readBody(req, res);
        if (body === null) return;
        let batch: unknown;
        try { batch = JSON.parse(body.toString('utf8')); }
        catch { return json(res, 400, { error: 'Invalid JSON' }); }
        if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return json(res, 400, { error: 'Invalid v1 event batch' });
        const candidate = batch as Record<string, unknown>;
        if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.events) || candidate.events.length > 100 ||
            !candidate.events.every(isEventRecord) || !candidate.events.every(event => config.projects.includes(event.project))) {
          return json(res, 400, { error: 'Invalid v1 event batch' });
        }
        if (storage.mode === 'sqlite' && candidate.events.length > config.maxEvents) {
          return json(res, 413, { error: 'Batch exceeds configured event capacity' });
        }
        try { return json(res, 200, await storage.writeBatch(candidate.events)); }
        catch { return json(res, 503, { error: 'Storage unavailable' }); }
      }
      if (origin && !own.has(origin)) return json(res, 403, { error: 'Origin not allowed' });
      if (!requireViewer(req, res, config.viewerPassword)) return;
      if (pathname === '/api/events' && req.method === 'GET') {
        if (!storage.queryable) return json(res, 501, { error: 'Queries unavailable in jsonl mode' });
        let filter: EventFilter;
        try { filter = listFilter(url); }
        catch { return json(res, 400, { error: 'Invalid request' }); }
        try { return json(res, 200, storage.list(filter)); }
        catch (error) {
          if (error instanceof Error && (error.message === 'Invalid cursor' || error.message === 'Invalid date filter')) return json(res, 400, { error: 'Invalid request' });
          return json(res, 503, { error: 'Storage unavailable' });
        }
      }
      if (pathname.startsWith(DETAIL_PREFIX) && req.method === 'GET') {
        if (!storage.queryable) return json(res, 501, { error: 'Queries unavailable in jsonl mode' });
        let eventId: string;
        try { eventId = decodeURIComponent(pathname.slice(DETAIL_PREFIX.length)); }
        catch { return json(res, 400, { error: 'Invalid request' }); }
        let project: string | undefined;
        try { project = boundedParam(url, 'project', 64); }
        catch { return json(res, 400, { error: 'Invalid request' }); }
        if (!eventId || eventId.length > 8192 || !project) return json(res, 400, { error: 'Invalid request' });
        try {
          const event = storage.get(project, eventId);
          return json(res, event ? 200 : 404, event ?? { error: 'Event not found' });
        } catch { return json(res, 503, { error: 'Storage unavailable' }); }
      }
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
      if (req.method !== 'GET') return json(res, 404, { error: 'Not found' });
      if (pathname === '/' && config.mode === 'jsonl') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Browser Error Log</title><h1>Browser Error Log</h1><p>JSONL log-only mode is enabled. The event query API and live viewer are unavailable.</p><p><a href="/install.html">Connect the SDK</a></p></html>');
        return;
      }
      return staticFile(res, config, target.split('?')[0]);
    })().catch(() => json(res, 500, { error: 'Internal server error' }));
  });
  server.requestTimeout = BODY_TIMEOUT_MS;
  server.headersTimeout = BODY_TIMEOUT_MS;
  server.timeout = BODY_TIMEOUT_MS;
  return server;
}
