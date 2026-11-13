import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogDiagnosticsClient, type BrowserErrorLogOptions } from './index';

const clients: BrowserErrorLogDiagnosticsClient[] = [];

function client(overrides: Partial<BrowserErrorLogOptions> = {}) {
  const batches: EventBatch[] = [];
  const options: BrowserErrorLogOptions = { project: 'web', captureNetwork: false, maxQueueSize: 100,
    flushIntervalMs: 60_000, transport: batch => { batches.push(batch); }, ...overrides };
  const instance = init(options);
  clients.push(instance);
  return { instance, batches, options };
}

function capture(instance: BrowserErrorLogDiagnosticsClient, count: number): void {
  for (let index = 0; index < count; index++) instance.captureException(`event ${index}`);
}

afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('maxBatchSize', () => {
  it('keeps the default at 20 events per sequential batch', async () => {
    const { instance, batches } = client();
    capture(instance, 21);
    await instance.flush();
    expect(batches.map(batch => batch.events.length)).toEqual([20, 1]);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 21, dropped: 0 });
  });

  it('drains five events as 2, 2, 1 in FIFO order with unique IDs and exact stats', async () => {
    const { instance, batches } = client({ maxBatchSize: 2 });
    capture(instance, 5);
    await instance.flush();
    expect(batches.map(batch => batch.events.length)).toEqual([2, 2, 1]);
    const events = batches.flatMap(batch => batch.events);
    expect(events.map(event => event.message)).toEqual(Array.from({ length: 5 }, (_, i) => `event ${i}`));
    expect(new Set(events.map(event => event.eventId)).size).toBe(5);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 5, dropped: 0 });
  });

  it('floors and clamps finite values, and defaults malformed values', async () => {
    for (const [maxBatchSize, count, sizes] of [
      [2.9, 5, [2, 2, 1]], [0, 5, [1, 1, 1, 1, 1]],
      [99, 21, [20, 1]], [Number.NaN, 21, [20, 1]], ['2', 21, [20, 1]],
    ] as const) {
      const { instance, batches } = client({ maxBatchSize: maxBatchSize as number });
      capture(instance, count);
      await instance.flush();
      expect(batches.map(batch => batch.events.length)).toEqual(sizes);
    }
  });

  it('snapshots the option before later caller mutation', async () => {
    const { instance, batches, options } = client({ maxBatchSize: 2 });
    options.maxBatchSize = 20;
    capture(instance, 3);
    await instance.flush();
    expect(batches.map(batch => batch.events.length)).toEqual([2, 1]);
  });

  it('applies the same cap to native fetch delivery', async () => {
    const fetch = vi.fn((_url: string, _request: RequestInit) => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetch);
    const { instance } = client({ transport: undefined, endpoint: '/collect', maxBatchSize: 2 });
    capture(instance, 5);
    await instance.flush();
    expect(fetch.mock.calls.map(([, request]) => JSON.parse(request.body as string).events.length)).toEqual([2, 2, 1]);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 5, dropped: 0 });
  });

  it('retries the chosen chunk with the same IDs without running beforeSend again', async () => {
    vi.useFakeTimers();
    const attempts: EventBatch[] = [];
    const beforeSend = vi.fn(event => event);
    const { instance } = client({ maxBatchSize: 2, beforeSend, transport: batch => {
      attempts.push(batch);
      if (attempts.length === 1) throw { status: 429 };
    } });
    capture(instance, 3);
    const flushing = instance.flush();
    await vi.advanceTimersByTimeAsync(250);
    await flushing;
    expect(attempts.map(batch => batch.events.map(event => event.message))).toEqual([
      ['event 0', 'event 1'], ['event 0', 'event 1'], ['event 2'],
    ]);
    expect(attempts[1]).toBe(attempts[0]);
    expect(beforeSend).toHaveBeenCalledTimes(3);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 3, dropped: 0 });
  });

  it('still splits on the independent byte budget', async () => {
    const { instance, batches } = client({ maxBatchSize: 5 });
    for (let index = 0; index < 5; index++) {
      const error = new Error(`event ${index}`);
      error.stack = 'x'.repeat(4000);
      instance.captureException(error, {
        componentStack: 'x'.repeat(2048),
        context: Object.fromEntries(Array.from({ length: 12 }, (_, key) => [`field${key}`, 'x'.repeat(500)])),
      });
    }
    await instance.flush();
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap(batch => batch.events).map(event => event.message))
      .toEqual(Array.from({ length: 5 }, (_, index) => `event ${index}`));
    expect(instance.getStats()).toEqual({ queued: 0, sent: 5, dropped: 0 });
  });

  it('beacons only one configured chunk, while the default still caps at ten', () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const configured = client({ transport: undefined, endpoint: '/collect', maxBatchSize: 2 }).instance;
    capture(configured, 5);
    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(configured.getStats()).toEqual({ queued: 3, sent: 2, dropped: 0 });
    configured.destroy();

    const standard = client({ transport: undefined, endpoint: '/collect' }).instance;
    capture(standard, 11);
    window.dispatchEvent(new Event('pagehide'));
    expect(standard.getStats()).toEqual({ queued: 1, sent: 10, dropped: 0 });
  });

  it('preserves queued events when a configured beacon returns false or throws', async () => {
    for (const outcome of ['false', 'throw']) {
      const sendBeacon = vi.fn(() => {
        if (outcome === 'throw') throw new Error('unavailable');
        return false;
      });
      vi.stubGlobal('navigator', { sendBeacon });
      const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
      vi.stubGlobal('fetch', fetch);
      const { instance } = client({ transport: undefined, endpoint: '/collect', maxBatchSize: 2 });
      capture(instance, 3);
      window.dispatchEvent(new Event('pagehide'));
      expect(instance.getStats()).toEqual({ queued: 3, sent: 0, dropped: 0 });
      await instance.flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(instance.getStats()).toEqual({ queued: 0, sent: 3, dropped: 0 });
      instance.destroy();
    }
  });
});
