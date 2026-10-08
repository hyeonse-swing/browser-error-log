import { describe, expect, it, vi } from 'vitest';
import type { ErrorEventRecord, EventDataSource, EventFilter, EventPage } from 'browser-error-log-protocol';
import { filterHistory, loadHistory, MAX_HISTORY_EVENTS, MAX_IMPORT_BYTES, parseHistoryJson, serializeHistory } from './history';

function event(overrides: Partial<ErrorEventRecord> = {}): ErrorEventRecord {
  return {
    schemaVersion: 1, eventId: 'one', project: 'web', environment: 'production', release: 'v1',
    sdkVersion: '0.1.0', occurredAt: '2026-10-02T00:00:00.000Z', viewId: 'view', sequence: 1,
    elapsedMs: 1, type: 'javascript', message: 'broken', page: '/home', runtime: 'browser', ...overrides,
  };
}

function source(listEvents: EventDataSource['listEvents']): EventDataSource {
  return { listEvents, getEvent: async () => null };
}

describe('historical loading', () => {
  it('keeps fixed filters, deduplicates by project and event ID, and sorts numeric timestamps', async () => {
    const rows = [
      { events: [event({ eventId: 'shared', project: 'web', occurredAt: '2026-10-02T09:00:00+09:00' }), event({ eventId: 'shared', project: 'admin', occurredAt: '2026-10-02T00:01:00Z' })], nextCursor: 'page-2' },
      { events: [event({ eventId: 'shared', project: 'web', message: 'duplicate' }), event({ eventId: 'older', occurredAt: '2026-10-01T23:59:00Z' })] },
    ];
    const calls: EventFilter[] = [];
    const progress: number[] = [];
    const result = await loadHistory(source(async filter => {
      calls.push(filter);
      return rows[calls.length - 1];
    }), { project: 'web', from: '2026-10-01T00:00:00Z', to: '2026-10-02T23:59:59Z', cursor: 'ignored', limit: 1 },
    new AbortController().signal, count => progress.push(count));
    expect(calls).toEqual([
      { project: 'web', from: '2026-10-01T00:00:00Z', to: '2026-10-02T23:59:59Z', limit: 100 },
      { project: 'web', from: '2026-10-01T00:00:00Z', to: '2026-10-02T23:59:59Z', limit: 100, cursor: 'page-2' },
    ]);
    expect(progress).toEqual([2, 3]);
    expect(result).toMatchObject({ truncated: false, duplicates: 1 });
    expect(result.events.map(({ project, eventId }) => [project, eventId])).toEqual([
      ['admin', 'shared'], ['web', 'shared'], ['web', 'older'],
    ]);
    expect(result.events[1].occurredAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('stops at 100 pages and 10,000 unique records, reporting more pages', async () => {
    let calls = 0;
    const listEvents = vi.fn(async (): Promise<EventPage> => {
      const page = calls++;
      return {
        events: Array.from({ length: 100 }, (_, index) => event({ eventId: `id-${page * 100 + index}` })),
        nextCursor: String(page + 1),
      };
    });
    const result = await loadHistory(source(listEvents), {}, new AbortController().signal);
    expect(listEvents).toHaveBeenCalledTimes(100);
    expect(result).toMatchObject({ truncated: true, duplicates: 0 });
    expect(result.events).toHaveLength(MAX_HISTORY_EVENTS);
  });

  it('rejects a failed later page and malformed pages instead of returning partial history', async () => {
    let calls = 0;
    await expect(loadHistory(source(async () => ++calls === 1
      ? { events: [event()], nextCursor: 'next' }
      : Promise.reject(new Error('HTTP 503'))), {}, new AbortController().signal)).rejects.toThrow('HTTP 503');
    await expect(loadHistory(source(async () => ({ events: [], nextCursor: 'next' })), {}, new AbortController().signal))
      .rejects.toThrow(/empty but returned a next cursor/);
    await expect(loadHistory(source(async () => ({ events: [{ ...event(), type: 'unknown' } as unknown as ErrorEventRecord] })), {}, new AbortController().signal))
      .rejects.toThrow(/type/);
    await expect(loadHistory(source(async () => ({ events: [event()], nextCursor: 'again' })), {}, new AbortController().signal))
      .rejects.toThrow(/repeated a cursor/);
  });

  it('rejects promptly when a custom source ignores the abort signal', async () => {
    const controller = new AbortController();
    const pending = loadHistory(source(() => new Promise<EventPage>(() => {})), {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(loadHistory(source(async () => ({ events: [] })), {}, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('portable history', () => {
  it('normalizes timezone offsets, projects safe fields, and round-trips a v1 envelope', () => {
    const raw = {
      ...event({ occurredAt: '2026-10-02T09:00:00+09:00' }),
      secret: 'discard me', context: { source: 'test', count: 2, okay: true, absent: null },
      network: { method: 'GET', url: '/api', durationMs: 9, status: 503, secret: 'discard me' },
    };
    const result = parseHistoryJson(JSON.stringify([raw, { ...raw, eventId: 'two' }]));
    expect(result).toMatchObject({ truncated: false, duplicates: 0 });
    expect(result.events[0].occurredAt).toBe('2026-10-02T00:00:00.000Z');
    expect(result.events[0]).not.toHaveProperty('secret');
    expect(result.events[0].network).not.toHaveProperty('secret');
    expect(parseHistoryJson(serializeHistory(result.events))).toEqual(result);
  });

  it('preserves capped-history provenance through export and rejects invalid partial flags', () => {
    const exported = serializeHistory([event()], { truncated: true });
    expect(JSON.parse(exported)).toMatchObject({ schemaVersion: 1, partial: true });
    expect(parseHistoryJson(exported)).toMatchObject({ truncated: true, duplicates: 0, events: [event()] });
    expect(parseHistoryJson(JSON.stringify({ schemaVersion: 1, partial: false, events: [event()] })).truncated).toBe(false);
    expect(parseHistoryJson(JSON.stringify([event()])).truncated).toBe(false);
    expect(() => parseHistoryJson(JSON.stringify({ schemaVersion: 1, partial: 'true', events: [event()] })))
      .toThrow(/partial/);
  });

  it('rejects malformed imports, dates, nested context, and oversize content', () => {
    expect(() => parseHistoryJson('{')).toThrow(/JSON/);
    expect(() => parseHistoryJson(JSON.stringify({ schemaVersion: 2, events: [] }))).toThrow(/version/);
    expect(() => parseHistoryJson(JSON.stringify([{ ...event(), occurredAt: '2026-10-02' }]))).toThrow(/ISO/);
    expect(() => parseHistoryJson(JSON.stringify([{ ...event(), occurredAt: '2026-02-30T00:00:00Z' }]))).toThrow(/invalid/);
    expect(() => parseHistoryJson(JSON.stringify([{ ...event(), context: { nested: { x: 1 } } }]))).toThrow(/context/);
    expect(() => parseHistoryJson(JSON.stringify([{ ...event(), network: { method: 'GET', url: '/', durationMs: '9' } }]))).toThrow(/durationMs/);
    expect(() => parseHistoryJson('x'.repeat(MAX_IMPORT_BYTES + 1))).toThrow(/10 MiB/);
    expect(() => parseHistoryJson(JSON.stringify(Array(MAX_HISTORY_EVENTS + 1).fill(event())))).toThrow(/up to/);
  });

  it('filters an imported history with inclusive numeric time boundaries and existing query fields', () => {
    const rows = parseHistoryJson(JSON.stringify([
      event({ eventId: 'at-start', occurredAt: '2026-10-02T09:00:00+09:00', message: 'target' }),
      event({ eventId: 'at-end', occurredAt: '2026-10-02T00:05:00Z', network: { method: 'GET', url: '/target', durationMs: 1 } }),
      event({ eventId: 'outside', occurredAt: '2026-10-02T00:05:00.001Z', message: 'target' }),
    ])).events;
    expect(filterHistory(rows, { project: 'web', environment: 'production', query: 'target',
      from: '2026-10-02T00:00:00Z', to: '2026-10-02T00:05:00Z' }).map(row => row.eventId))
      .toEqual(['at-end', 'at-start']);
  });
});
