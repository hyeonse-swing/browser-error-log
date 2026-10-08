import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createCollectorHandler, json } from './handler.ts';
import { EventStore, createSampleEvents } from './store.ts';

// Local loopback verification harness only. No database, durable storage or auth.
export function localCollector(demoOnly = false): Plugin {
  const store = new EventStore();
  createSampleEvents().forEach(e => store.add(e));
  const handle = createCollectorHandler(store, true);
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    let pathname: string;
    try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; }
    catch { return json(res, 400, { error: 'Invalid request' }); }
    if ((demoOnly || !pathname.startsWith('/api/')) && !pathname.startsWith('/demo-api/')) return next();
    if (req.headers.origin && !['http://127.0.0.1:4317', 'http://localhost:4317'].includes(req.headers.origin)) return json(res, 403, { error: 'Local origin required' });
    return handle(req, res, next);
  };
  return { name: 'local-error-log-collector', configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
