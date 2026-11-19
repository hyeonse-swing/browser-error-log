import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, type BrowserErrorLogDeliveryClient } from './index';

const clients: BrowserErrorLogDeliveryClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('delivery reliability', () => {
  it('splits a rejected native batch and delivers every original event ID', async () => {
    const attempts: string[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      const batch = JSON.parse(String(options.body)) as { events: { eventId: string }[] };
      attempts.push(batch.events.map(event => event.eventId));
      return new Response(null, { status: batch.events.length > 2 ? 413 : 204 });
    }));
    const client = init({ project: 'test', endpoint: '/api/events', captureNetwork: false,
      flushIntervalMs: 60_000, deliveryStatusLimit: 4 });
    clients.push(client);
    const ids = Array.from({ length: 4 }, (_, index) => client.captureException(`error ${index}`)!);

    await client.flush();

    expect(attempts).toEqual([ids, ids.slice(0, 2), ids.slice(2)]);
    expect(client.getStats()).toEqual({ queued: 0, sent: 4, dropped: 0 });
    expect(ids.map(id => client.getDeliveryStatus(id))).toEqual(Array(4).fill({ state: 'transport-accepted' }));
  });

  it('uses pristine events when a size-limited custom transport mutates its rejected batch', async () => {
    const attempts: string[][] = [];
    const client = init({ project: 'test', captureNetwork: false, flushIntervalMs: 60_000,
      transport: batch => {
        attempts.push(batch.events.map(event => event.eventId));
        if (batch.events.length > 2) {
          batch.events.length = 0;
          throw { status: 413 };
        }
      } });
    clients.push(client);
    const ids = Array.from({ length: 4 }, (_, index) => client.captureException(`error ${index}`)!);

    await client.flush();

    expect(attempts).toEqual([ids, ids.slice(0, 2), ids.slice(2)]);
    expect(client.getStats()).toEqual({ queued: 0, sent: 4, dropped: 0 });
  });

  it('backs up only unfinished split events on pagehide without double-counting them', async () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const attempts: string[][] = [];
    let completeLast!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
      const batch = JSON.parse(String(options.body)) as { events: { eventId: string }[] };
      attempts.push(batch.events.map(event => event.eventId));
      if (batch.events.length > 2) return Promise.resolve(new Response(null, { status: 413 }));
      if (attempts.length === 2) return Promise.resolve(new Response(null, { status: 204 }));
      return new Promise<Response>(resolve => { completeLast = resolve; });
    }));
    const client = init({ project: 'test', endpoint: '/api/events', captureNetwork: false,
      flushIntervalMs: 60_000, deliveryStatusLimit: 4 });
    clients.push(client);
    const ids = Array.from({ length: 4 }, (_, index) => client.captureException(`error ${index}`)!);
    const flushing = client.flush();
    await vi.waitFor(() => expect(attempts).toHaveLength(3));
    expect(client.getStats().sent).toBe(2);

    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(client.getStats()).toEqual({ queued: 0, sent: 4, dropped: 0 });
    expect(ids.map(id => client.getDeliveryStatus(id).state))
      .toEqual(['transport-accepted', 'transport-accepted', 'beacon-queued', 'beacon-queued']);

    completeLast(new Response(null, { status: 204 }));
    await flushing;
    expect(client.getStats()).toEqual({ queued: 0, sent: 4, dropped: 0 });
  });

  it('does not resend a beaconed prefix after the original fetch rejects a 20-event batch', async () => {
    const sendBeacon = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.stubGlobal('navigator', { sendBeacon });
    const attempts: string[][] = [];
    let completeOriginal!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
      const batch = JSON.parse(String(options.body)) as { events: { eventId: string }[] };
      attempts.push(batch.events.map(event => event.eventId));
      if (attempts.length === 1) return new Promise<Response>(resolve => { completeOriginal = resolve; });
      return Promise.resolve(new Response(null, { status: 204 }));
    }));
    const client = init({ project: 'test', endpoint: '/api/events', captureNetwork: false,
      flushIntervalMs: 60_000, deliveryStatusLimit: 20 });
    clients.push(client);
    const ids = Array.from({ length: 20 }, (_, index) => client.captureException(`error ${index}`)!);
    const flushing = client.flush();
    expect(attempts).toEqual([ids]);

    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(2);
    expect(client.getStats()).toEqual({ queued: 0, sent: 10, dropped: 0 });
    completeOriginal(new Response(null, { status: 413 }));
    await flushing;

    expect(attempts).toEqual([ids, ids.slice(10, 15), ids.slice(15)]);
    expect(client.getStats()).toEqual({ queued: 0, sent: 20, dropped: 0 });
    expect(ids.map(id => client.getDeliveryStatus(id).state))
      .toEqual([...Array(10).fill('beacon-queued'), ...Array(10).fill('transport-accepted')]);
  });

  it('tries one remaining event once after a rejected batch and records a final 413 drop', async () => {
    const sendBeacon = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.stubGlobal('navigator', { sendBeacon });
    const attempts: string[][] = [];
    let completeOriginal!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
      const batch = JSON.parse(String(options.body)) as { events: { eventId: string }[] };
      attempts.push(batch.events.map(event => event.eventId));
      return attempts.length === 1
        ? new Promise<Response>(resolve => { completeOriginal = resolve; })
        : Promise.resolve(new Response(null, { status: 413 }));
    }));
    const client = init({ project: 'test', endpoint: '/api/events', captureNetwork: false,
      flushIntervalMs: 60_000, deliveryStatusLimit: 11 });
    clients.push(client);
    const ids = Array.from({ length: 11 }, (_, index) => client.captureException(`error ${index}`)!);
    const flushing = client.flush();
    window.dispatchEvent(new Event('pagehide'));
    completeOriginal(new Response(null, { status: 413 }));
    await flushing;

    expect(attempts).toEqual([ids, ids.slice(10)]);
    expect(client.getStats()).toEqual({ queued: 0, sent: 10, dropped: 1 });
    expect(ids.slice(0, 10).map(id => client.getDeliveryStatus(id).state))
      .toEqual(Array(10).fill('beacon-queued'));
    expect(client.getDeliveryStatus(ids[10]!)).toEqual({ state: 'dropped', reason: 'deliveryError' });
  });

  it('filters a new beaconed prefix before starting the second split child', async () => {
    const sendBeacon = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.stubGlobal('navigator', { sendBeacon });
    const attempts: string[][] = [];
    let completeFirstChild!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
      const batch = JSON.parse(String(options.body)) as { events: { eventId: string }[] };
      attempts.push(batch.events.map(event => event.eventId));
      if (attempts.length === 1) return Promise.resolve(new Response(null, { status: 413 }));
      if (attempts.length === 2) return new Promise<Response>(resolve => { completeFirstChild = resolve; });
      return Promise.resolve(new Response(null, { status: 204 }));
    }));
    const client = init({ project: 'test', endpoint: '/api/events', captureNetwork: false,
      flushIntervalMs: 60_000, deliveryStatusLimit: 12 });
    clients.push(client);
    const ids = Array.from({ length: 12 }, (_, index) => client.captureException(`error ${index}`)!);
    const flushing = client.flush();
    await vi.waitFor(() => expect(attempts).toHaveLength(2));

    window.dispatchEvent(new Event('pagehide'));
    expect(client.getStats().sent).toBe(10);
    completeFirstChild(new Response(null, { status: 204 }));
    await flushing;

    expect(attempts).toEqual([ids, ids.slice(0, 6), ids.slice(10)]);
    expect(client.getStats()).toEqual({ queued: 0, sent: 12, dropped: 0 });
    expect(ids.map(id => client.getDeliveryStatus(id).state)).toEqual([
      ...Array(6).fill('transport-accepted'), ...Array(4).fill('beacon-queued'),
      ...Array(2).fill('transport-accepted'),
    ]);
  });

  it('counts only unfinished split events as dropped when destroyed mid-delivery', async () => {
    const attempts: string[][] = [];
    const client = init({ project: 'test', captureNetwork: false,
      flushIntervalMs: 60_000, deliveryStatusLimit: 4, transport: batch => {
        attempts.push(batch.events.map(event => event.eventId));
        if (batch.events.length > 2) throw { status: 413 };
        if (attempts.length === 3) return new Promise<void>(() => {});
      } });
    clients.push(client);
    const ids = Array.from({ length: 4 }, (_, index) => client.captureException(`error ${index}`)!);
    const flushing = client.flush();
    await vi.waitFor(() => expect(attempts).toHaveLength(3));
    client.destroy();
    await flushing;

    expect(client.getStats()).toEqual({ queued: 0, sent: 2, dropped: 2 });
    expect(ids.map(id => client.getDeliveryStatus(id))).toEqual([
      { state: 'transport-accepted' }, { state: 'transport-accepted' },
      { state: 'dropped', reason: 'destroyed' }, { state: 'dropped', reason: 'destroyed' },
    ]);
  });

  it('does not count a failed split twice when destroyed during another split', async () => {
    const attempts: string[][] = [];
    const client = init({ project: 'test', captureNetwork: false,
      flushIntervalMs: 60_000, deliveryStatusLimit: 4, transport: batch => {
        attempts.push(batch.events.map(event => event.eventId));
        if (batch.events.length > 2) throw { status: 413 };
        if (attempts.length === 2) throw { status: 400 };
        return new Promise<void>(() => {});
      } });
    clients.push(client);
    const ids = Array.from({ length: 4 }, (_, index) => client.captureException(`error ${index}`)!);
    const flushing = client.flush();
    await vi.waitFor(() => expect(attempts).toHaveLength(3));
    client.destroy();
    await flushing;

    expect(client.getStats()).toEqual({ queued: 0, sent: 0, dropped: 4 });
    expect(ids.map(id => client.getDeliveryStatus(id))).toEqual([
      { state: 'dropped', reason: 'deliveryError' }, { state: 'dropped', reason: 'deliveryError' },
      { state: 'dropped', reason: 'destroyed' }, { state: 'dropped', reason: 'destroyed' },
    ]);
  });

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
