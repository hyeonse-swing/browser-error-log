import { describe, expect, it } from 'vitest';
import { createSampleEvents, EventStore, isEventRecord } from './store';
describe('local collector contract', () => {
  it('deduplicates retries without replacing the original event', () => {
    const store = new EventStore(); const e = createSampleEvents()[0];
    expect(store.add(e)).toBe(true); expect(store.add({ ...e, message: 'retry' })).toBe(false);
    expect(store.list({}).events).toHaveLength(1); expect(store.get(e.project, e.eventId)?.message).toBe(e.message);
  });
  it('keeps cursor pages stable when a newer event arrives', () => {
    const store = new EventStore(); const rows = createSampleEvents(); rows.forEach(e => store.add(e));
    const first = store.list({ limit: 5 });
    store.add({ ...rows[0], eventId: 'new', occurredAt: new Date(Date.now() + 1000).toISOString() });
    const second = store.list({ limit: 5, cursor: first.nextCursor });
    expect(second.events.map(e => e.eventId)).toEqual(rows.slice(5, 10).map(e => e.eventId));
  });
  it('filters and bounds in-memory storage', () => {
    const store = new EventStore(5); createSampleEvents().forEach(e => store.add(e));
    expect(store.list({}).events).toHaveLength(5);
    expect(store.list({ type: 'manual' }).events.every(e => e.type === 'manual')).toBe(true);
  });
  it('rejects malformed dates and structured messages', () => {
    const e = createSampleEvents()[0]; expect(isEventRecord(e)).toBe(true);
    expect(isEventRecord({ ...e, occurredAt: 'yesterday' })).toBe(false);
    expect(isEventRecord({ ...e, message: { html: '<script>' } })).toBe(false);
  });
  it('separates identical event IDs across projects in details and pagination', () => {
    const store = new EventStore(); const e = createSampleEvents()[0];
    store.add({ ...e, project: 'alpha', message: 'alpha event' });
    store.add({ ...e, project: 'beta', message: 'beta event' });
    expect(store.get('alpha', e.eventId)?.message).toBe('alpha event');
    expect(store.get('beta', e.eventId)?.message).toBe('beta event');
    const first = store.list({ limit: 1 });
    const second = store.list({ limit: 1, cursor: first.nextCursor });
    expect(first.events[0].project).toBe('beta');
    expect(second.events[0].project).toBe('alpha');
    expect(second.nextCursor).toBeUndefined();
  });
  it('does not confuse project and event IDs containing the key separator', () => {
    const store = new EventStore(); const event = createSampleEvents()[0];
    const first = { ...event, project: 'a\u0000b', eventId: 'c' };
    const second = { ...event, project: 'a', eventId: 'b\u0000c' };
    expect(store.add(first)).toBe(true);
    expect(store.add(second)).toBe(true);
    expect(store.list({}).events).toHaveLength(2);
    expect(store.get(first.project, first.eventId)?.project).toBe(first.project);
    expect(store.get(second.project, second.eventId)?.eventId).toBe(second.eventId);
  });
  it('sorts, filters, and pages timestamps by instant across offset formats', () => {
    const store = new EventStore(); const event = createSampleEvents()[0];
    store.add({ ...event, eventId: 'older', occurredAt: '2026-10-02T09:00:00+09:00' });
    store.add({ ...event, eventId: 'boundary', occurredAt: '2026-10-02T00:15:00Z' });
    store.add({ ...event, eventId: 'newer', occurredAt: '2026-10-02T00:30:00.000Z' });
    expect(store.list({}).events.map(e => e.eventId)).toEqual(['newer', 'boundary', 'older']);
    expect(store.get(event.project, 'older')?.occurredAt).toBe('2026-10-02T00:00:00.000Z');
    expect(store.list({ from: '2026-10-02T00:15:00Z' }).events.map(e => e.eventId)).toEqual(['newer', 'boundary']);
    expect(store.list({ to: '2026-10-02T09:15:00+09:00' }).events.map(e => e.eventId)).toEqual(['boundary', 'older']);
    const first = store.list({ limit: 1 });
    const second = store.list({ limit: 1, cursor: first.nextCursor });
    const third = store.list({ limit: 1, cursor: second.nextCursor });
    expect([first.events[0].eventId, second.events[0].eventId, third.events[0].eventId]).toEqual(['newer', 'boundary', 'older']);
    expect(() => store.list({ from: 'not-a-date' })).toThrow('Invalid date filter');
  });
});
