import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, type BrowserErrorLogDeliveryClient } from './index';

const clients: BrowserErrorLogDeliveryClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('delivery reliability', () => {
  it('retries the original event after a custom transport mutates and rejects an attempt', async () => {
    vi.useFakeTimers();
    const attempts: { id: string; message: string }[][] = [];
    const client = init({ project: 'test', captureNetwork: false, flushIntervalMs: 60_000,
      deliveryStatusLimit: 2, transport: batch => {
        attempts.push(batch.events.map(event => ({ id: event.eventId, message: event.message })));
        if (attempts.length === 1) {
          batch.events[0]!.message = 'changed by transport';
          batch.events.length = 0;
          throw { status: 503 };
        }
      } });
    clients.push(client);
    const id = client.captureException('original')!;
    const flushing = client.flush();
    await vi.advanceTimersByTimeAsync(250);
    await flushing;

    expect(attempts).toEqual([[{ id, message: 'original' }], [{ id, message: 'original' }]]);
    expect(client.getDeliveryStatus(id)).toEqual({ state: 'transport-accepted' });
    expect(client.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
  });

  it('isolates retries from a timed-out transport that can still mutate its batch', async () => {
    vi.useFakeTimers();
    const attempts: { events: { eventId: string; message: string }[] }[] = [];
    let finishSecond!: () => void;
    const client = init({ project: 'test', captureNetwork: false, flushIntervalMs: 60_000,
      transportTimeoutMs: 250, transport: batch => {
        attempts.push(batch);
        if (attempts.length === 1) return new Promise<void>(() => {});
        return new Promise<void>(resolve => { finishSecond = resolve; });
      } });
    clients.push(client);
    const id = client.captureException('original')!;
    const flushing = client.flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).not.toBe(attempts[0]);
    attempts[0]!.events[0]!.message = 'late mutation';
    attempts[0]!.events.length = 0;
    expect(attempts[1]!.events.map(event => ({ id: event.eventId, message: event.message })))
      .toEqual([{ id, message: 'original' }]);
    finishSecond();
    await flushing;
    expect(client.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
  });

  it('does not register completed sends on a shared pending destroy promise', async () => {
    const originalRace = Promise.race.bind(Promise);
    const destroyWaiters: unknown[] = [];
    vi.spyOn(Promise, 'race').mockImplementation(((values: Iterable<unknown>) => {
      const attempts = Array.from(values);
      if (attempts.length === 3) destroyWaiters.push(attempts[2]);
      return originalRace(attempts);
    }) as typeof Promise.race);

    const client = init({ project: 'test', captureNetwork: false,
      flushIntervalMs: 60_000, transport: () => {} });
    clients.push(client);
    for (let index = 0; index < 24; index++) {
      client.captureException(`event ${index}`);
      await client.flush();
    }

    expect(client.getStats().sent).toBe(24);
    expect(destroyWaiters).toHaveLength(24);
    expect(new Set(destroyWaiters).size).toBe(24);
    expect((client as unknown as { cancelWaits: Set<() => void> }).cancelWaits.size).toBe(0);
  });
});
