import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, type BrowserErrorLogCaptureClient, type BrowserErrorLogDeliveryClient } from './index';

const clients: BrowserErrorLogDeliveryClient[] = [];

function client(overrides: Partial<Parameters<typeof init>[0]> = {}): BrowserErrorLogDeliveryClient {
  const instance = init({ project: 'test', captureNetwork: false, transport: () => {},
    flushIntervalMs: 60_000, ...overrides });
  clients.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('per-event delivery status', () => {
  it('is opt-in, bounded, scoped to a client, and returns detached snapshots', () => {
    const existingCaptureClient: BrowserErrorLogCaptureClient = {
      captureException: () => undefined, flush: async () => {}, destroy: () => {},
      getStats: () => ({ queued: 0, sent: 0, dropped: 0 }),
      getDiagnostics: () => ({ queued: 0, sent: 0, dropped: 0, inFlight: 0,
        filtered: 0, deduplicated: 0, droppedByReason: {
          rateLimit: 0, queueOverflow: 0, payloadTooLarge: 0,
          processingError: 0, deliveryError: 0, destroyed: 0,
        } }),
      addBreadcrumb: () => {}, clearBreadcrumbs: () => {},
    };
    expect(existingCaptureClient.captureException('legacy')).toBeUndefined();

    const untracked = client();
    const untrackedId = untracked.captureException('untracked')!;
    expect(untracked.getDeliveryStatus(untrackedId)).toEqual({ state: 'unknown' });

    const tracked = client({ deliveryStatusLimit: 2 });
    const anotherTracked = client({ deliveryStatusLimit: 2 });
    const first = tracked.captureException('first')!;
    const second = tracked.captureException('second')!;
    expect(tracked.getDeliveryStatus(first)).toEqual({ state: 'queued' });
    expect(tracked.getDeliveryStatus(second)).toEqual({ state: 'queued' });
    expect(untracked.getDeliveryStatus(first)).toEqual({ state: 'unknown' });
    expect(anotherTracked.getDeliveryStatus(first)).toEqual({ state: 'unknown' });
    const snapshot = tracked.getDeliveryStatus(second);
    snapshot.state = 'unknown';
    expect(tracked.getDeliveryStatus(second)).toEqual({ state: 'queued' });

    const third = tracked.captureException('third')!;
    expect(tracked.getDeliveryStatus(first)).toEqual({ state: 'unknown' });
    expect(tracked.getDeliveryStatus(third)).toEqual({ state: 'queued' });
    expect(tracked.getDeliveryStatus('not-admitted')).toEqual({ state: 'unknown' });
  });

  it('keeps default aggregate counts when a custom transport mutates its batch', async () => {
    const untracked = client({ transport: batch => { batch.events.length = 0; } });
    const id = untracked.captureException('no tracking')!;
    await untracked.flush();
    expect(untracked.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
    expect(untracked.getDeliveryStatus(id)).toEqual({ state: 'unknown' });
  });

  it('keeps the original IDs during transport reentry and batch mutation', async () => {
    let release!: () => void;
    let instance!: BrowserErrorLogDeliveryClient;
    let nestedId!: string;
    let calls = 0;
    instance = client({ deliveryStatusLimit: 5, transport: batch => {
      calls++;
      if (calls === 1) {
        nestedId = instance.captureException('nested')!;
        batch.events.length = 0;
        return new Promise<void>(resolve => { release = resolve; });
      }
    } });
    const first = instance.captureException('first')!;
    const flushing = instance.flush();
    expect(instance.getDeliveryStatus(first)).toEqual({ state: 'in-flight' });
    expect(instance.getDeliveryStatus(nestedId)).toEqual({ state: 'queued' });
    release();
    await flushing;
    expect(instance.getDeliveryStatus(first)).toEqual({ state: 'transport-accepted' });
    expect(instance.getDeliveryStatus(nestedId)).toEqual({ state: 'transport-accepted' });
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 0 });
  });

  it('retains in-flight status across retries and reports a final delivery failure', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const retrying = client({ deliveryStatusLimit: 2, transport: () => {
      attempts++;
      throw { status: 503 };
    } });
    const id = retrying.captureException('retry')!;
    const flushing = retrying.flush();
    expect(retrying.getDeliveryStatus(id)).toEqual({ state: 'in-flight' });
    await vi.advanceTimersByTimeAsync(250);
    expect(attempts).toBe(2);
    expect(retrying.getDeliveryStatus(id)).toEqual({ state: 'in-flight' });
    await vi.advanceTimersByTimeAsync(500);
    await flushing;
    expect(attempts).toBe(3);
    expect(retrying.getDeliveryStatus(id)).toEqual({ state: 'dropped', reason: 'deliveryError' });
  });

  it('reports overflow and destruction of queued and in-flight events', async () => {
    let release!: () => void;
    const instance = client({ deliveryStatusLimit: 5, maxQueueSize: 2,
      transport: () => new Promise<void>(resolve => { release = resolve; }) });
    const inFlight = instance.captureException('in-flight')!;
    const flushing = instance.flush();
    const evicted = instance.captureException('evicted')!;
    instance.captureException('queued')!;
    const last = instance.captureException('last')!;
    expect(instance.getDeliveryStatus(inFlight)).toEqual({ state: 'in-flight' });
    expect(instance.getDeliveryStatus(evicted)).toEqual({ state: 'dropped', reason: 'queueOverflow' });
    expect(instance.getDeliveryStatus(last)).toEqual({ state: 'queued' });
    instance.destroy();
    expect(instance.getDeliveryStatus(inFlight)).toEqual({ state: 'dropped', reason: 'destroyed' });
    expect(instance.getDeliveryStatus(last)).toEqual({ state: 'dropped', reason: 'destroyed' });
    expect(instance.getDeliveryStatus(evicted)).toEqual({ state: 'dropped', reason: 'queueOverflow' });
    release();
    await flushing;
    expect(instance.getDeliveryStatus(inFlight)).toEqual({ state: 'dropped', reason: 'destroyed' });
  });

  it('distinguishes beacon queue acceptance from a queued event', () => {
    const beacon = vi.fn(() => false);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const instance = client({ deliveryStatusLimit: 2, transport: undefined, endpoint: '/collector' });
    const id = instance.captureException('beacon')!;
    window.dispatchEvent(new Event('pagehide'));
    expect(instance.getDeliveryStatus(id)).toEqual({ state: 'queued' });
    beacon.mockReturnValue(true);
    window.dispatchEvent(new Event('pagehide'));
    expect(instance.getDeliveryStatus(id)).toEqual({ state: 'beacon-queued' });
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
    instance.destroy();
    expect(instance.getDeliveryStatus(id)).toEqual({ state: 'beacon-queued' });
  });

  it('rejects invalid limits and caps a large one at 100 entries', () => {
    for (const invalid of [NaN, Infinity, -1, '20']) {
      const instance = client({ deliveryStatusLimit: invalid as number });
      const id = instance.captureException('ignored')!;
      expect(instance.getDeliveryStatus(id)).toEqual({ state: 'unknown' });
    }
    const instance = client({ deliveryStatusLimit: 1_000, maxQueueSize: 100 });
    const ids = Array.from({ length: 101 }, (_, index) => instance.captureException(`event ${index}`)!);
    expect(instance.getDeliveryStatus(ids[0])).toEqual({ state: 'unknown' });
    expect(instance.getDeliveryStatus(ids[1]).state).not.toBe('unknown');
    expect(instance.getDeliveryStatus(ids[100]).state).not.toBe('unknown');
  });
});
