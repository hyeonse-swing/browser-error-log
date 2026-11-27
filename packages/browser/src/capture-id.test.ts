import { afterEach, describe, expect, it } from 'vitest';
import { parseEventReference, type EventBatch } from '@ihyeon/browser-error-log-protocol';
import { formatEventReference, init, type BrowserErrorLogClient, type BrowserErrorLogDiagnosticsClient, type BrowserErrorLogOptions } from './index';
import { EventStore, isEventRecord } from '../../../apps/local-collector/store';

const clients: BrowserErrorLogClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

describe('manual capture event ID', () => {
  it('keeps each client bound to its initialization settings when the caller reuses an options object', async () => {
    const firstStore = new EventStore();
    const secondStore = new EventStore();
    const options: BrowserErrorLogOptions = {
      project: 'first',
      captureNetwork: false,
      transport: batch => { batch.events.forEach(event => firstStore.add(event)); },
    };
    const first = init(options);
    clients.push(first);

    options.project = 'second';
    options.transport = batch => { batch.events.forEach(event => secondStore.add(event)); };
    const second = init(options);
    clients.push(second);
    const firstReference = first.captureExceptionWithReference(new Error('first failure'));
    const secondReference = second.captureExceptionWithReference(new Error('second failure'));

    await first.flush();
    await second.flush();
    expect(parseEventReference(formatEventReference(firstReference))).toEqual(firstReference);
    expect(parseEventReference(formatEventReference(secondReference))).toEqual(secondReference);
    expect(firstStore.get(firstReference!.project, firstReference!.eventId)?.message).toBe('first failure');
    expect(secondStore.get(secondReference!.project, secondReference!.eventId)?.message).toBe('second failure');
    expect(firstReference!.project).toBe('first');
    expect(secondReference!.project).toBe('second');
    expect(first.getStats().sent).toBe(1);
    expect(second.getStats().sent).toBe(1);
  });

  it('rejects project names that become blank on the wire', async () => {
    for (const project of ['   ', `${' '.repeat(80)}valid`]) {
      expect(() => init({ project, captureNetwork: false, transport: () => {} }))
        .toThrow('project is required');
    }

    const store = new EventStore();
    const client = init({ project: ' valid ', captureNetwork: false,
      transport: batch => { batch.events.forEach(event => store.add(event)); } });
    clients.push(client);
    const reference = client.captureExceptionWithReference(new Error('valid failure'));
    await client.flush();
    expect(parseEventReference(formatEventReference(reference))).toEqual(reference);
    expect(store.get(reference!.project, reference!.eventId)?.message).toBe('valid failure');
  });

  it('returns the ID delivered in the batch, including after a retry', async () => {
    const attempts: EventBatch[] = [];
    const store = new EventStore();
    const client = init({
      project: 'test', captureNetwork: false,
      transport: batch => {
        attempts.push(batch);
        if (attempts.length === 1) throw new Error('temporary collector failure');
        for (const event of batch.events) {
          expect(isEventRecord(event)).toBe(true);
          store.add(event);
        }
      },
      beforeSend: event => ({ ...event, eventId: 'ignored-hook-id' }),
    });
    clients.push(client);

    const id = client.captureException(new Error('payment flow failed'));
    expect(id).toEqual(expect.any(String));
    await client.flush();

    expect(attempts).toHaveLength(2);
    expect(attempts.map(batch => batch.events[0].eventId)).toEqual([id, id]);
    expect(store.get('test', id!)?.eventId).toBe(id);
    expect(store.get('test', 'ignored-hook-id')).toBeNull();
    expect(client.getStats()).toMatchObject({ sent: 1, dropped: 0 });
  });

  it('returns only the lookup fields used by the collector', async () => {
    const store = new EventStore();
    const client = init({
      project: 'a'.repeat(90), captureNetwork: false,
      beforeSend: event => ({ ...event, project: 'rewritten', eventId: 'rewritten' }),
      transport: batch => { batch.events.forEach(event => store.add(event)); },
    });
    clients.push(client);

    const error = new Error('review failed');
    const reference = client.captureExceptionWithReference(error);
    expect(reference).toEqual({ project: 'a'.repeat(80), eventId: expect.any(String) });
    const copied = formatEventReference(reference);
    expect(parseEventReference(copied)).toEqual(reference);
    expect(client.captureExceptionWithReference(error)).toBeUndefined();
    expect(formatEventReference(undefined)).toBeUndefined();
    await client.flush();
    expect(store.get(reference!.project, reference!.eventId)?.message).toBe('review failed');
    expect(client.getStats().sent).toBe(1);
  });

  it('returns no ID when the candidate is not admitted', async () => {
    const sent: EventBatch[] = [];
    const client = init({ project: 'test', captureNetwork: false,
      transport: batch => { sent.push(batch); },
      maxEventsPerMinute: 1,
      beforeSend: event => event.message === 'filtered' ? false : event,
    });
    clients.push(client);

    expect(client.captureException('filtered')).toBeUndefined();
    const error = new Error('accepted');
    const id = client.captureException(error);
    expect(id).toEqual(expect.any(String));
    expect(client.captureException(error)).toBeUndefined();
    expect(client.captureException(new Error('over limit'))).toBeUndefined();
    await client.flush();

    expect(sent.flatMap(batch => batch.events).map(event => event.eventId)).toEqual([id]);
    expect(client.getDiagnostics()).toMatchObject({ filtered: 1, deduplicated: 1,
      droppedByReason: { rateLimit: 1 } });
  });

  it('returns no ID when disabled or destroyed', () => {
    const disabled = init({ project: 'test', enabled: false, captureNetwork: false,
      transport: () => {} });
    clients.push(disabled);
    expect(disabled.captureException('disabled')).toBeUndefined();

    const active = init({ project: 'test', captureNetwork: false,
      transport: () => {} });
    clients.push(active);
    active.destroy();
    expect(active.captureException('after destroy')).toBeUndefined();
  });

  it('preserves the original void-returning client interface for adapters', () => {
    const legacyClient: BrowserErrorLogClient = {
      captureException: () => {}, flush: async () => {}, destroy: () => {},
      getStats: () => ({ queued: 0, sent: 0, dropped: 0 }),
    };
    expect(legacyClient.captureException('handled')).toBeUndefined();
    const legacyDiagnosticsClient: BrowserErrorLogDiagnosticsClient = {
      ...legacyClient,
      getDiagnostics: () => ({ queued: 0, sent: 0, dropped: 0, inFlight: 0,
        filtered: 0, deduplicated: 0, droppedByReason: {
          rateLimit: 0, queueOverflow: 0, payloadTooLarge: 0,
          processingError: 0, deliveryError: 0, destroyed: 0,
        } }),
      addBreadcrumb: () => {}, clearBreadcrumbs: () => {},
    };
    expect(legacyDiagnosticsClient.captureException('handled')).toBeUndefined();
  });
});
