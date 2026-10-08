import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createCollectorHandler, json } from './handler.ts';
import { EventStore } from './store.ts';

const DEFAULT_PORT = 4318;
const VIEWER_ORIGINS = ['http://127.0.0.1:4317', 'http://localhost:4317'];

export function collectorPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw new Error('ERROR_LOG_COLLECTOR_PORT must be an integer from 1 to 65535');
  return Number(value);
}

export function allowedOrigins(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(',').map(raw => {
    const origin = raw.trim();
    let url: URL;
    try { url = new URL(origin); }
    catch { throw new Error('ERROR_LOG_ALLOWED_ORIGINS must contain exact http/https origins'); }
    if (!['http:', 'https:'].includes(url.protocol) || origin.includes('*') || origin !== url.origin || url.username || url.password || url.search || url.hash) {
      throw new Error('ERROR_LOG_ALLOWED_ORIGINS must contain exact http/https origins');
    }
    return origin;
  });
}

function loopbackHost(req: IncomingMessage, port: number): boolean {
  return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
}

function preflightMethod(pathname: string, method: string | undefined): boolean {
  if (pathname === '/api/events') return method === 'GET' || method === 'POST';
  return method === 'GET' && (pathname === '/api/health' || (pathname.startsWith('/api/events/') && pathname.length > '/api/events/'.length));
}

export function createStandaloneCollectorServer(extraOrigins: string[] = []): Server {
  const store = new EventStore();
  const handle = createCollectorHandler(store);
  const server = createServer(async (req, res) => {
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : DEFAULT_PORT;
    if (!loopbackHost(req, port)) return json(res, 403, { error: 'Loopback Host required' });
    let pathname: string;
    try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; }
    catch { return json(res, 400, { error: 'Invalid request' }); }
    const origins = new Set([...VIEWER_ORIGINS, `http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraOrigins]);
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return json(res, 403, { error: 'Origin not allowed' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method'];
      const requestedHeaders = req.headers['access-control-request-headers'];
      const headers = typeof requestedHeaders === 'string' ? requestedHeaders.toLowerCase().split(',').map(h => h.trim()) : [];
      if (!origin || !preflightMethod(pathname, method) || headers.some(h => h !== 'content-type') || (method === 'POST' && pathname !== '/api/events')) {
        return json(res, 403, { error: 'Preflight not allowed' });
      }
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Methods', method!);
      if (headers.length) res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }
    if (req.method === 'POST' && pathname === '/api/events' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return json(res, 415, { error: 'application/json required' });
    }
    await handle(req, res, () => json(res, 404, { error: 'Unknown local endpoint' }));
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = collectorPort(process.env.ERROR_LOG_COLLECTOR_PORT);
  const server = createStandaloneCollectorServer(allowedOrigins(process.env.ERROR_LOG_ALLOWED_ORIGINS));
  server.listen(port, '127.0.0.1', () => console.log(`Collector listening on http://127.0.0.1:${port}`));
}
