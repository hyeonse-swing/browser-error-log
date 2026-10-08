import type { ErrorEventRecord, EventFilter, EventPage, EventType } from '@browser-error-log/protocol';

const types = new Set<EventType>(['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual']);
const runtimes = new Set(['browser', 'webview-ios', 'webview-android', 'unknown']);
export function isEventRecord(value: unknown): value is ErrorEventRecord {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (e.schemaVersion !== 1 || !types.has(e.type as EventType) || !runtimes.has(e.runtime as string)) return false;
  for (const key of ['eventId', 'project', 'environment', 'release', 'sdkVersion', 'occurredAt', 'viewId', 'message', 'page']) {
    if (typeof e[key] !== 'string' || (e[key] as string).length > 8192) return false;
  }
  if (!e.eventId || !e.project || !Number.isFinite(Date.parse(e.occurredAt as string))) return false;
  if (!Number.isInteger(e.sequence) || (e.sequence as number) < 0 || typeof e.elapsedMs !== 'number' || !Number.isFinite(e.elapsedMs) || e.elapsedMs < 0) return false;
  for (const key of ['name', 'stack', 'componentStack', 'browser']) if (e[key] !== undefined && (typeof e[key] !== 'string' || (e[key] as string).length > 16384)) return false;
  if (e.context !== undefined && (!e.context || typeof e.context !== 'object' || Array.isArray(e.context) || Object.values(e.context).some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v)))) return false;
  if (e.network !== undefined) {
    if (!e.network || typeof e.network !== 'object') return false;
    const n = e.network as Record<string, unknown>;
    if (typeof n.method !== 'string' || typeof n.url !== 'string' || typeof n.durationMs !== 'number' || !Number.isFinite(n.durationMs) || n.durationMs < 0) return false;
    if (n.status !== undefined && (!Number.isInteger(n.status) || (n.status as number) < 0 || (n.status as number) > 599)) return false;
  }
  return true;
}

export class EventStore {
  private events = new Map<string, ErrorEventRecord>();
  constructor(private capacity = 2000) {}
  add(event: ErrorEventRecord): boolean {
    // Public IDs are unique within a project, not globally across installations.
    const key = JSON.stringify([event.project, event.eventId]);
    if (this.events.has(key)) return false;
    this.events.set(key, { ...event, occurredAt: new Date(event.occurredAt).toISOString(), receivedAt: new Date().toISOString() });
    while (this.events.size > this.capacity) this.events.delete(this.events.keys().next().value!);
    return true;
  }
  get(project: string, id: string): ErrorEventRecord | null { return this.events.get(JSON.stringify([project, id])) ?? null; }
  clear() { this.events.clear(); }
  list(filter: EventFilter): EventPage {
    const boundary = (value: string | undefined): string | undefined => {
      if (!value) return undefined;
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) throw new Error('Invalid date filter');
      return new Date(parsed).toISOString();
    };
    const from = boundary(filter.from);
    const to = boundary(filter.to);
    const query = (filter.query ?? '').toLocaleLowerCase();
    const rows = [...this.events.values()].filter(e =>
      (!filter.project || e.project === filter.project) &&
      (!filter.environment || e.environment === filter.environment) &&
      (!filter.type || e.type === filter.type) &&
      (!from || e.occurredAt >= from) &&
      (!to || e.occurredAt <= to) &&
      (!query || `${e.message} ${e.page} ${e.eventId} ${e.release} ${e.network?.url ?? ''}`.toLocaleLowerCase().includes(query))
    ).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.eventId.localeCompare(a.eventId) || b.project.localeCompare(a.project));
    // Opaque cursor keeps pagination stable when newer records arrive.
    let start = 0;
    if (filter.cursor) {
      try {
        const tuple = JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(tuple) || tuple.length !== 3 || tuple.some(v => typeof v !== 'string')) throw new Error('Invalid cursor');
        const [at, id, project] = tuple;
        start = rows.findIndex(e => e.occurredAt.localeCompare(at) < 0 || (e.occurredAt === at && (e.eventId.localeCompare(id) < 0 || (e.eventId === id && e.project.localeCompare(project) < 0))));
        if (start < 0) return { events: [] };
      } catch { throw new Error('Invalid cursor'); }
    }
    const limit = Math.min(100, Math.max(1, Number(filter.limit) || 50));
    const events = rows.slice(start, start + limit);
    const last = events.at(-1);
    return { events, ...(last && start + limit < rows.length ? { nextCursor: Buffer.from(JSON.stringify([last.occurredAt, last.eventId, last.project])).toString('base64url') } : {}) };
  }
}

export function createSampleEvents(): ErrorEventRecord[] {
  const samples: [EventType, string, string][] = [
    ['javascript', "Cannot read properties of undefined (reading 'name')", '/products/:id'],
    ['http', 'GET /api/orders/:id returned 503', '/orders/:id'],
    ['react', 'An exception occurred while rendering ProductSummary', '/products/:id'],
    ['network', 'Failed to fetch', '/checkout'],
    ['promise', 'Could not load product details', '/products'],
    ['console', 'Cart state does not match', '/cart'],
    ['manual', 'Demo: unexpected response format', '/settings'],
  ];
  const now = Date.now();
  const recent: ErrorEventRecord[] = Array.from({ length: 24 }, (_, index) => {
    const [type, message, page] = samples[index % samples.length];
    return {
      schemaVersion: 1, sdkVersion: '0.1.0', eventId: `sample-${String(index + 1).padStart(3, '0')}`,
      project: index % 3 === 0 ? 'sample-admin' : 'sample-web', environment: index % 4 === 0 ? 'staging' : 'development',
      release: 'sample-build-001', occurredAt: new Date(now - index * 193000 - 5000).toISOString(),
      viewId: `sample-view-${Math.floor(index / 4)}`, sequence: index + 1, elapsedMs: 3200 + index * 250,
      type, message, page, runtime: index % 3 === 0 ? 'webview-ios' : 'browser', browser: 'Sample browser',
      name: type === 'javascript' ? 'TypeError' : 'Error',
      stack: `Error: ${message}\n    at loadProduct (https://example.invalid/assets/app.js:42:18)\n    at onNavigate (https://example.invalid/assets/app.js:81:7)`,
      context: { source: 'sample', note: 'Demo data, not an error from a real service' },
      ...(type === 'react' ? { componentStack: '\n    at ProductSummary\n    at ProductPage\n    at App' } : {}),
      ...(['http', 'network'].includes(type) ? { network: { method: 'GET', url: '/api/orders/:id', durationMs: 312, ...(type === 'http' ? { status: 503 } : {}) } } : {}),
    };
  });
  // Labeled synthetic history for exercising date filters, charts and cursor pages.
  const history: ErrorEventRecord[] = [];
  for (let day = 1; day <= 29; day++) {
    const volume = 12 + (day % 6) * 4 + (day === 4 || day === 17 ? 48 : 0);
    for (let index = 0; index < volume; index++) {
      const base = recent[(index + day) % recent.length];
      const occurredAt = new Date(now - day * 86400000 - ((index + 1) / (volume + 1)) * 86400000).toISOString();
      history.push({ ...base, eventId: `sample-history-${day}-${index}`, occurredAt,
        project: index % 5 === 0 ? 'sample-webview' : base.project,
        environment: index % 5 === 0 ? 'staging' : 'production',
        release: `sample-build-00${day < 7 ? 3 : day < 20 ? 2 : 1}`,
        viewId: `sample-history-view-${day}-${Math.floor(index / 3)}`, sequence: index + 1,
        runtime: index % 5 === 0 ? 'webview-android' : base.runtime,
        ...(base.network ? { network: { ...base.network, durationMs: 100 + (index % 8) * 95 } } : {}),
      });
    }
  }
  return [...recent, ...history];
}
