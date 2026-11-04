import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogBreadcrumbClient, type BrowserErrorLogOptions } from './index';

const clients: BrowserErrorLogBreadcrumbClient[] = [];

function client(overrides: Partial<BrowserErrorLogOptions> = {}) {
  const batches: EventBatch[] = [];
  const options: BrowserErrorLogOptions = {
    project: 'web',
    transport: batch => { batches.push(JSON.parse(JSON.stringify(batch)) as EventBatch); },
    captureNetwork: false,
    ...overrides,
  };
  const instance = init(options);
  clients.push(instance);
  return { instance, options, batches, events: () => batches.flatMap(batch => batch.events) };
}

afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('maxEventsPerMinute', () => {
  it.each([undefined, NaN, Infinity, -Infinity, '2' as unknown as number])(
    'keeps the limiter disabled for %s', async maxEventsPerMinute => {
      const { instance, events } = client({ maxEventsPerMinute });
      for (let index = 0; index < 3; index++) instance.captureException(`event ${index}`);
      await instance.flush();
      expect(events()).toHaveLength(3);
      expect(instance.getStats()).toEqual({ queued: 0, sent: 3, dropped: 0 });
    },
  );

  it('floors and clamps finite values, then snapshots the option', async () => {
    const { instance, events, options } = client({ maxEventsPerMinute: 2.9 });
    options.maxEventsPerMinute = 1000;
    instance.captureException('one');
    instance.captureException('two');
    instance.captureException('three');
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['one', 'two']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 1 });

    const lower = client({ maxEventsPerMinute: -10 });
    lower.instance.captureException('one');
    lower.instance.captureException('two');
    await lower.instance.flush();
    expect(lower.events()).toHaveLength(1);
    expect(lower.instance.getStats().dropped).toBe(1);

    const upper = client({ maxEventsPerMinute: 10_000 });
    for (let index = 0; index < 1001; index++) {
      upper.instance.captureException(`event ${index}`);
      if (index % 20 === 19) await upper.instance.flush();
    }
    await upper.instance.flush();
    expect(upper.events()).toHaveLength(1000);
    expect(upper.instance.getStats()).toEqual({ queued: 0, sent: 1000, dropped: 1 });
  });

  it('uses a true sliding 60-second window with exact-age expiry', async () => {
    let tick = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => tick);
    const { instance, events } = client({ maxEventsPerMinute: 2 });
    instance.captureException('at zero');
    tick = 30_000;
    instance.captureException('at thirty');
    tick = 59_999;
    instance.captureException('too early');
    tick = 60_000;
    instance.captureException('first expired');
    tick = 89_999;
    instance.captureException('second still live');
    tick = 90_000;
    instance.captureException('second expired');
    await instance.flush();
    expect(events().map(event => event.message)).toEqual([
      'at zero', 'at thirty', 'first expired', 'second expired',
    ]);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 4, dropped: 2 });
  });

  it('keeps client budgets independent', async () => {
    const first = client({ maxEventsPerMinute: 1 });
    const second = client({ maxEventsPerMinute: 1 });
    first.instance.captureException('first client');
    second.instance.captureException('second client');
    first.instance.captureException('first full');
    second.instance.captureException('second full');
    await Promise.all([first.instance.flush(), second.instance.flush()]);
    expect(first.events().map(event => event.message)).toEqual(['first client']);
    expect(second.events().map(event => event.message)).toEqual(['second client']);
    expect(first.instance.getStats().dropped).toBe(1);
    expect(second.instance.getStats().dropped).toBe(1);
  });

  it('shares one budget across manual, React, global, promise, console, HTTP and network errors', async () => {
    const nativeConsole = vi.spyOn(console, 'error').mockImplementation(() => {});
    const nativeFetch = vi.fn((url: string) => url.includes('offline')
      ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal('fetch', nativeFetch);
    const { instance, events } = client({
      maxEventsPerMinute: 2, captureConsole: true, captureNetwork: true, endpoint: '/collector',
    });
    instance.captureException('manual');
    instance.captureException('react', { type: 'react' });
    window.dispatchEvent(new ErrorEvent('error', { message: 'global' }));
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new Error('promise') });
    window.dispatchEvent(rejection);
    console.error('console');
    await window.fetch('/failure');
    await expect(window.fetch('/offline')).rejects.toThrow('offline');
    await instance.flush();
    expect(events().map(event => event.type)).toEqual(['manual', 'react']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 5 });
    expect(nativeConsole).toHaveBeenCalledWith('console');
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it('does not charge filtered, throwing or oversize candidates and skips beforeSend when full', async () => {
    const beforeSend = vi.fn((event: EventBatch['events'][number]) => {
      if (event.message === 'filtered') return false;
      if (event.message === 'throwing') throw new Error('privacy hook');
      if (event.message === 'oversize') {
        event.context = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field${index}`, '\0'.repeat(500)]));
        event.stack = '\0'.repeat(4096);
      }
      return event;
    });
    const { instance, events } = client({ maxEventsPerMinute: 1, beforeSend });
    for (const message of ['filtered', 'throwing', 'oversize', 'kept', 'limited']) {
      instance.captureException(message);
    }
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['kept']);
    expect(beforeSend.mock.calls.map(([event]) => event.message)).toEqual([
      'filtered', 'throwing', 'oversize', 'kept',
    ]);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 3 });
  });

  it('rechecks capacity after a beforeSend hook captures the final slot', async () => {
    let instance!: BrowserErrorLogBreadcrumbClient;
    const result = client({ maxEventsPerMinute: 1, beforeSend: event => {
      if (event.message === 'outer') instance.captureException(new Error('inner'));
      return event;
    } });
    instance = result.instance;
    const outer = new Error('outer');
    instance.captureException(outer);
    await instance.flush();
    expect(result.events().map(event => event.message)).toEqual(['inner']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 1 });
  });

  it('does not charge duplicate objects and permits a limited object after expiry', async () => {
    let tick = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => tick);
    const { instance, events } = client({ maxEventsPerMinute: 1 });
    const first = new Error('first');
    const limited = new Error('limited');
    instance.captureException(first);
    instance.captureException(first);
    instance.captureException(limited);
    expect(instance.getStats()).toEqual({ queued: 1, sent: 0, dropped: 1 });
    tick = 60_000;
    instance.captureException(limited);
    instance.captureException(limited);
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['first', 'limited']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 1 });
  });

  it('does not replenish capacity on backward or nonfinite monotonic readings', async () => {
    let tick = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => tick);
    vi.spyOn(Date, 'now').mockReturnValue(1);
    const { instance, events } = client({ maxEventsPerMinute: 1 });
    instance.captureException('first');
    tick = 50;
    instance.captureException('backwards');
    tick = NaN;
    instance.captureException('nonfinite');
    tick = 60_099;
    instance.captureException('one millisecond early');
    tick = 60_100;
    instance.captureException('expired');
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['first', 'expired']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 3 });
  });

  it('clamps the wall-clock fallback when performance.now throws', async () => {
    let wall = 100_000;
    vi.spyOn(performance, 'now').mockImplementation(() => { throw new Error('no clock'); });
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const { instance, events } = client({ maxEventsPerMinute: 1 });
    instance.captureException('first');
    wall = 90_000;
    instance.captureException('rollback');
    wall = 159_999;
    instance.captureException('early');
    wall = 160_000;
    instance.captureException('expired');
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['first', 'expired']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 2 });
  });

  it('does not spend capacity again on retry, flush, or breadcrumbs', async () => {
    vi.useFakeTimers();
    const attempts: EventBatch[] = [];
    const nativeFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', nativeFetch);
    const transport = vi.fn((batch: EventBatch) => {
      attempts.push(batch);
      if (attempts.length === 1) throw { status: 429 };
    });
    const { instance } = client({
      maxEventsPerMinute: 1, transport, endpoint: '/collector', captureNavigation: true,
      captureNetworkBreadcrumbs: true,
    });
    const originalPath = window.location.pathname;
    instance.addBreadcrumb({ message: 'manual step' });
    history.pushState({}, '', '/rate-limit-step');
    await window.fetch('/ok');
    instance.captureException('first');
    const pending = instance.flush();
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    instance.clearBreadcrumbs();
    instance.captureException('still limited');
    await instance.flush();
    history.replaceState({}, '', originalPath);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].events[0].eventId).toBe(attempts[1].events[0].eventId);
    expect(attempts[0].events[0].breadcrumbs?.map(crumb => crumb.category)).toEqual(['manual', 'navigation', 'http']);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 1 });
  });

  it('records admission before auto-flush transport can capture synchronously', async () => {
    let instance!: BrowserErrorLogBreadcrumbClient;
    const attempts: EventBatch[] = [];
    const result = client({ maxEventsPerMinute: 1, maxQueueSize: 1, transport: batch => {
      attempts.push(batch);
      instance.captureException('nested transport capture');
    } });
    instance = result.instance;
    instance.captureException('first');
    await instance.flush();
    expect(attempts.map(batch => batch.events[0].message)).toEqual(['first']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 1 });
  });

  it('keeps admitted slots charged after queue eviction and permanent delivery failure', async () => {
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>(resolve => { releaseFirst = resolve; });
    const attempts: string[] = [];
    const { instance } = client({ maxEventsPerMinute: 3, maxQueueSize: 1, transport: async batch => {
      attempts.push(batch.events[0].message);
      if (attempts.length === 1) await firstDelivery;
      else throw { status: 400 };
    } });
    instance.captureException('first');
    instance.captureException('evicted');
    instance.captureException('delivery fails');
    instance.captureException('rate limited');
    releaseFirst();
    await instance.flush();
    instance.captureException('still rate limited');
    expect(attempts).toEqual(['first', 'delivery fails']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 4 });
  });

  it('does not reset the budget after a successful beacon', () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { sendBeacon }));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { instance } = client({ maxEventsPerMinute: 1, transport: undefined, endpoint: '/collector' });
    instance.captureException('beacon');
    document.dispatchEvent(new Event('visibilitychange'));
    instance.captureException('limited');
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 1 });
  });

  it('keeps disabled, server and destroyed clients inert', async () => {
    const disabled = client({ maxEventsPerMinute: 1, enabled: false, transport: undefined });
    disabled.instance.captureException('ignored');
    await disabled.instance.flush();
    expect(disabled.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });

    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    const server = client({ maxEventsPerMinute: 1, transport: undefined });
    server.instance.captureException('ignored');
    await server.instance.flush();
    server.instance.destroy();
    expect(server.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    vi.unstubAllGlobals();

    const active = client({ maxEventsPerMinute: 1 });
    active.instance.captureException('queued');
    active.instance.destroy();
    active.instance.captureException('ignored');
    await active.instance.flush();
    expect(active.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 1 });
  });
});
