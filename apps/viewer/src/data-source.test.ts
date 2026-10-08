import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventDataSource } from './data-source';

afterEach(() => vi.unstubAllGlobals());

describe('eventDataSource', () => {
  it('encodes event filters in the list request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    await eventDataSource.listEvents({ project: 'Café & web', query: 'TypeError: x/y', type: 'javascript', limit: 30 });

    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(url.pathname).toBe('/api/events');
    expect(url.searchParams.get('project')).toBe('Café & web');
    expect(url.searchParams.get('query')).toBe('TypeError: x/y');
    expect(url.searchParams.get('type')).toBe('javascript');
    expect(url.searchParams.get('limit')).toBe('30');
  });

  it('reports HTTP failures and treats a missing detail as absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: false, status: 404 }));

    await expect(eventDataSource.listEvents({})).rejects.toThrow('HTTP 503');
    await expect(eventDataSource.getEvent('project & one', 'missing/id')).resolves.toBeNull();
    const url = new URL(vi.mocked(fetch).mock.calls[1][0] as string, 'http://localhost');
    expect(url.pathname).toBe('/api/events/missing%2Fid');
    expect(url.searchParams.get('project')).toBe('project & one');
  });
});
