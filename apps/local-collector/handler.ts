import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventFilter } from '@browser-error-log/protocol';
import { EventStore, createSampleEvents, isEventRecord } from './store.ts';

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function createCollectorHandler(store: EventStore, demo = false) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/') && !(demo && url.pathname.startsWith('/demo-api/'))) return next();
      if (demo) {
        if (url.pathname === '/demo-api/network') { req.socket.destroy(); return; }
        if (url.pathname === '/demo-api/failure') return json(res, 503, { error: 'Intentional demo HTTP failure' });
        if (url.pathname === '/demo-api/slow') { setTimeout(() => { if (!res.destroyed) json(res, 200, { ok: true }); }, 1000); return; }
      }
      if (url.pathname === '/api/health') return json(res, 200, { mode: 'local-memory', durable: false });
      if (demo && url.pathname === '/api/reset' && req.method === 'POST') { store.clear(); return json(res, 200, { cleared: true }); }
      if (demo && url.pathname === '/api/seed' && req.method === 'POST') { createSampleEvents().forEach(e => store.add(e)); return json(res, 200, { seeded: true }); }
      if (url.pathname === '/api/events' && req.method === 'GET') return json(res, 200, store.list(Object.fromEntries(url.searchParams) as EventFilter));
      if (url.pathname.startsWith('/api/events/') && req.method === 'GET') {
        const project = url.searchParams.get('project');
        if (!project) return json(res, 400, { error: 'project is required for event details' });
        const event = store.get(project, decodeURIComponent(url.pathname.slice('/api/events/'.length)));
        return json(res, event ? 200 : 404, event ?? { error: 'Event not found' });
      }
      if (url.pathname === '/api/events' && req.method === 'POST') {
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 65536) return json(res, 413, { error: 'Batch exceeds 64 KiB' });
          chunks.push(Buffer.from(chunk));
        }
        let batch: unknown;
        try { batch = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return json(res, 400, { error: 'Invalid JSON' }); }
        if (!batch || typeof batch !== 'object') return json(res, 400, { error: 'Invalid v1 event batch' });
        const candidate = batch as Record<string, unknown>;
        if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.events) || candidate.events.length > 100 || !candidate.events.every(isEventRecord)) return json(res, 400, { error: 'Invalid v1 event batch' });
        let stored = 0;
        for (const event of candidate.events) if (store.add(event)) stored++;
        return json(res, 200, { accepted: candidate.events.length, stored, duplicates: candidate.events.length - stored });
      }
      return json(res, 404, { error: 'Unknown local endpoint' });
    } catch { return json(res, 400, { error: 'Invalid request' }); }
  };
}
