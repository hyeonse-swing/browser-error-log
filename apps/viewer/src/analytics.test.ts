import { describe, expect, it } from 'vitest';
import type { ErrorEventRecord } from 'browser-error-log-protocol';
import { buildAnalytics } from './analytics';

function event(overrides: Partial<ErrorEventRecord> = {}): ErrorEventRecord {
  return {
    schemaVersion: 1, eventId: 'one', project: 'web', environment: 'production', release: 'v1',
    sdkVersion: '0.1.0', occurredAt: '2026-10-02T00:00:00.000Z', viewId: 'view', sequence: 1,
    elapsedMs: 1, type: 'javascript', message: 'broken', page: '/home?path=%2F', runtime: 'browser', ...overrides,
  };
}

describe('buildAnalytics', () => {
  it('counts every distribution and groups top messages by project, type, and message', () => {
    const rows = [
      event({ eventId: 'a', message: 'same', occurredAt: '2026-10-02T00:00:00Z' }),
      event({ eventId: 'b', message: 'same', occurredAt: '2026-10-02T00:01:00Z' }),
      event({ eventId: 'c', project: 'admin', message: 'same', release: 'v1', page: '/admin' }),
      event({ eventId: 'd', type: 'http', message: 'same', network: { method: 'GET', url: '/api', status: 503, durationMs: 1 } }),
      event({ eventId: 'e', type: 'network', message: 'offline', network: { method: 'GET', url: '/api', durationMs: 1 } }),
      event({ eventId: 'f', type: 'network', message: 'zero', network: { method: 'GET', url: '/api', status: 0, durationMs: 1 } }),
    ];
    const result = buildAnalytics(rows);
    expect(result.total).toBe(6);
    expect(result.uniqueErrors).toBe(5);
    expect(result.networkErrors).toBe(3);
    expect(result.projectsCount).toBe(2);
    expect(result.types).toHaveLength(7);
    expect(result.types.find(row => row.key === 'manual')?.count).toBe(0);
    expect(result.projects.map(row => [row.key, row.count])).toEqual([['web', 5], ['admin', 1]]);
    expect(result.releases).toEqual([
      { key: JSON.stringify(['web', 'v1']), label: 'web · v1', count: 5 },
      { key: JSON.stringify(['admin', 'v1']), label: 'admin · v1', count: 1 },
    ]);
    expect(result.pages.find(row => row.key === '/home?path=%2F')?.count).toBe(5);
    expect(result.httpStatuses.map(row => [row.key, row.count])).toEqual([['No response', 2], ['503', 1]]);
    expect(result.topErrors[0]).toMatchObject({
      key: JSON.stringify(['web', 'javascript', 'same']), count: 2, lastOccurredAt: '2026-10-02T00:01:00Z',
      event: { eventId: 'b' },
    });
    expect(result.topErrors.filter(row => row.message === 'same')).toHaveLength(3);
    expect(result.trend.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(result.total);
  });

  it('uses inclusive range endpoints and separate adjacent buckets with zero gaps', () => {
    const range = { from: '2026-10-02T00:00:00Z', to: '2026-10-02T00:30:00Z' };
    const rows = [
      event({ eventId: 'start', occurredAt: '2026-10-02T00:00:00Z' }),
      event({ eventId: 'before-edge', occurredAt: '2026-10-02T00:04:59.999Z' }),
      event({ eventId: 'edge', occurredAt: '2026-10-02T00:05:00Z', type: 'http' }),
      event({ eventId: 'end', occurredAt: '2026-10-02T00:30:00Z' }),
      event({ eventId: 'outside', occurredAt: '2026-10-02T00:30:00.001Z' }),
    ];
    const result = buildAnalytics(rows, range);
    expect(result.intervalMs).toBe(5 * 60_000);
    expect(result.trend.map(bucket => bucket.count)).toEqual([2, 1, 0, 0, 0, 0, 1]);
    expect(result.trend[0].to + 1).toBe(result.trend[1].from);
    expect(result.trend[1].types.http).toBe(1);
    expect(result.total).toBe(4);
    expect(result.types.reduce((sum, row) => sum + row.count, 0)).toBe(result.total);
  });

  it('keeps empty explicit ranges useful and huge ranges bounded', () => {
    const empty = buildAnalytics([], { from: '2026-10-02T00:00:00Z', to: '2026-10-03T00:00:00Z' });
    expect(empty.total).toBe(0);
    expect(empty.from).toBe(Date.parse('2026-10-02T00:00:00Z'));
    expect(empty.to).toBe(Date.parse('2026-10-03T00:00:00Z'));
    expect(empty.trend.length).toBeGreaterThan(1);
    expect(empty.trend.every(bucket => bucket.count === 0)).toBe(true);
    expect(buildAnalytics([])).toMatchObject({ from: 0, to: 0, total: 0 });
    const huge = buildAnalytics([], { from: '2000-01-01T00:00:00Z', to: '2050-01-01T00:00:00Z' });
    expect(huge.trend.length).toBeLessThanOrEqual(100);
    expect(huge.intervalMs).toBeGreaterThan(7 * 24 * 60 * 60_000);
  });

  it('limits the message ranking to eight deterministic rows', () => {
    const rows = Array.from({ length: 9 }, (_, index) => event({
      eventId: `id-${index}`, message: `message-${index}`, occurredAt: new Date(Date.parse('2026-10-02T00:00:00Z') + index).toISOString(),
    }));
    const result = buildAnalytics(rows);
    expect(result.uniqueErrors).toBe(9);
    expect(result.topErrors).toHaveLength(8);
    expect(result.topErrors[0].message).toBe('message-8');
    expect(result.topErrors.at(-1)?.message).toBe('message-1');
  });
});
