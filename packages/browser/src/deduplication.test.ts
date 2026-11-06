import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogDiagnosticsClient, type BrowserErrorLogOptions } from './index';

const clients: BrowserErrorLogDiagnosticsClient[] = [];
function client(overrides: Partial<BrowserErrorLogOptions> = {}) {
  const batches: EventBatch[] = [];
  const options: BrowserErrorLogOptions = { project: 'test', captureNetwork: false,
    transport: batch => { batches.push(batch); }, ...overrides };
  const instance = init(options);
  clients.push(instance);
  return { instance, options, events: () => batches.flatMap(batch => batch.events) };
}
afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('dedupeIntervalMs', () => {
  it.each([undefined, NaN, Infinity, -Infinity, '100' as unknown as number, -1, 0, 0.9])(
    'leaves value dedupe disabled for %s', value => {
      const { instance } = client({ dedupeIntervalMs: value });
      instance.captureException(new Error('same'));
      instance.captureException(new Error('same'));
      expect(instance.getDiagnostics()).toMatchObject({ queued: 2, deduplicated: 0 });
    });

  it('floors, caps, and snapshots the interval', () => {
    let tick = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => tick);
    const first = client({ dedupeIntervalMs: 2.9 });
    first.options.dedupeIntervalMs = 0;
    first.instance.captureException('same');
    tick = 1;
    first.instance.captureException('same');
    tick = 2;
    first.instance.captureException('same');
    expect(first.instance.getDiagnostics()).toMatchObject({ queued: 2, deduplicated: 1 });
    const capped = client({ dedupeIntervalMs: 100_000 });
    capped.instance.captureException('same');
    tick += 59_999;
    capped.instance.captureException('same');
    tick++;
    capped.instance.captureException('same');
    expect(capped.instance.getDiagnostics()).toMatchObject({ queued: 2, deduplicated: 1 });
  });

  it('deduplicates distinct errors, preserves diagnostics shape, and retains object identity suppression', () => {
    const { instance } = client({ dedupeIntervalMs: 1000 });
    const error = new Error('same');
    error.stack = 'same stack';
    const another = new Error('same');
    another.stack = 'same stack';
    instance.captureException(error);
    instance.captureException(another);
    instance.captureException(error);
    expect(instance.getDiagnostics()).toMatchObject({ queued: 1, deduplicated: 2, filtered: 0,
      dropped: 0, droppedByReason: { rateLimit: 0 } });
    expect(instance.getStats()).toEqual({ queued: 1, sent: 0, dropped: 0 });
  });

  it('expires at the exact boundary without extending the window on repeats', () => {
    let tick = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => tick);
    const { instance } = client({ dedupeIntervalMs: 100 });
    instance.captureException('same');
    tick = 50; instance.captureException('same');
    tick = 99; instance.captureException('same');
    tick = 100; instance.captureException('same');
    tick = 150; instance.captureException('same');
    expect(instance.getDiagnostics()).toMatchObject({ queued: 2, deduplicated: 3 });
  });

  it('uses all identity fields and canonical context keys, excluding timing and breadcrumbs', () => {
    const { instance } = client({ dedupeIntervalMs: 1000 });
    const capture = (context: Record<string, unknown>, stack = 'stack', componentStack = 'component') =>
      instance.captureException({ message: 'same', stack }, { context, componentStack });
    capture({ a: 1, resourceUrl: '/one' });
    capture({ resourceUrl: '/one', a: 1 });
    instance.addBreadcrumb({ message: 'different trail' });
    capture({ a: 1, resourceUrl: '/one' });
    capture({ a: 1, resourceUrl: '/two' });
    capture({ a: 2, resourceUrl: '/one' });
    capture({ a: 1, resourceUrl: '/one' }, 'other stack');
    capture({ a: 1, resourceUrl: '/one' }, 'stack', 'other component');
    instance.captureException({ message: 'same', stack: 'stack' }, { context: { a: 1, resourceUrl: '/one' }, type: 'react' });
    expect(instance.getDiagnostics()).toMatchObject({ queued: 6, deduplicated: 2 });
  });

  it('distinguishes page and network method, URL and status while ignoring duration', () => {
    const { instance } = client({ dedupeIntervalMs: 1000, captureNetwork: true, endpoint: '/collector' });
    const network = instance as BrowserErrorLogDiagnosticsClient & {
      reportNetwork(method: string, url: string, status: number, durationMs: number): void;
    };
    network.reportNetwork('GET', '/one', 503, 10);
    network.reportNetwork('GET', '/one', 503, 20);
    network.reportNetwork('POST', '/one', 503, 20);
    network.reportNetwork('GET', '/two', 503, 20);
    network.reportNetwork('GET', '/one', 502, 20);
    instance.captureException('page');
    history.pushState({}, '', '/other-page');
    instance.captureException('page');
    expect(instance.getDiagnostics()).toMatchObject({ queued: 6, deduplicated: 1 });
  });

  it('does not cache filtered, throwing, or oversized candidates', () => {
    let reject = true;
    const { instance } = client({ dedupeIntervalMs: 1000, beforeSend: event => {
      if (reject) {
        if (event.message === 'filtered') return false;
        if (event.message === 'throwing') throw Error('hook');
        if (event.message === 'oversized') {
          event.stack = '\0'.repeat(4096);
          event.context = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field${i}`, '\0'.repeat(500)]));
        }
      }
      return event;
    } });
    for (const message of ['filtered', 'throwing', 'oversized']) instance.captureException(message);
    reject = false;
    for (const message of ['filtered', 'throwing', 'oversized']) instance.captureException(message);
    expect(instance.getDiagnostics()).toMatchObject({ queued: 3, filtered: 1, deduplicated: 0, dropped: 2 });
  });

  it('keys on final beforeSend values and preserves early rate limit precedence', () => {
    const hook = vi.fn((event: EventBatch['events'][number]) => { event.message = 'normalized'; return event; });
    const { instance } = client({ dedupeIntervalMs: 1000, maxEventsPerMinute: 1, beforeSend: hook });
    instance.captureException('first');
    instance.captureException('second');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(instance.getDiagnostics()).toMatchObject({ queued: 1, deduplicated: 0, droppedByReason: { rateLimit: 1 } });
    const unlimited = client({ dedupeIntervalMs: 1000, beforeSend: hook });
    unlimited.instance.captureException('first');
    unlimited.instance.captureException('second');
    expect(unlimited.instance.getDiagnostics()).toMatchObject({ queued: 1, deduplicated: 1 });
  });

  it('handles beforeSend reentry and records before auto flush transport reentry', () => {
    let instance!: BrowserErrorLogDiagnosticsClient;
    let hookEntered = false;
    const result = client({ dedupeIntervalMs: 1000, maxQueueSize: 1,
      beforeSend: event => {
        if (!hookEntered) { hookEntered = true; instance.captureException('same'); }
        return event;
      },
      transport: () => { instance.captureException('same'); },
    });
    instance = result.instance;
    instance.captureException('same');
    expect(instance.getDiagnostics()).toMatchObject({ deduplicated: 2, dropped: 0 });
  });

  it('evicts the oldest of 50 admitted keys and retains sanitized signatures only', () => {
    const { instance } = client({ dedupeIntervalMs: 1000, maxQueueSize: 100 });
    for (let i = 0; i < 51; i++) instance.captureException(`message ${i}`);
    instance.captureException('message 0');
    instance.captureException('message 50');
    expect(instance.getDiagnostics()).toMatchObject({ deduplicated: 1 });
    const internal = instance as unknown as { dedupeCache: Map<string, number> };
    expect(internal.dedupeCache.size).toBe(50);
    const secret = client({ dedupeIntervalMs: 1000 });
    secret.instance.captureException('https://example.test/?token=raw-secret');
    const secretCache = (secret.instance as unknown as { dedupeCache: Map<string, number> }).dedupeCache;
    expect([...secretCache.keys()].join('')).not.toContain('raw-secret');
  });

  it('keeps clients independent and accepted windows through flush, failure and queue eviction', async () => {
    const first = client({ dedupeIntervalMs: 1000, maxQueueSize: 1, transport: () => { throw { status: 400 }; } });
    const second = client({ dedupeIntervalMs: 1000 });
    first.instance.captureException('same');
    first.instance.captureException('other');
    await first.instance.flush();
    first.instance.captureException('same');
    second.instance.captureException('same');
    expect(first.instance.getDiagnostics().deduplicated).toBe(1);
    expect(second.instance.getDiagnostics().deduplicated).toBe(0);
  });

  it('clamps backward and nonfinite clock readings; value-suppressed objects retry after expiry', () => {
    let tick = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => tick);
    const { instance } = client({ dedupeIntervalMs: 100 });
    const first = new Error('same');
    first.stack = 'same stack';
    instance.captureException(first);
    const retry = new Error('same');
    retry.stack = 'same stack';
    tick = 50; instance.captureException(retry);
    tick = NaN; instance.captureException(retry);
    tick = 199; instance.captureException(retry);
    tick = 200; instance.captureException(retry);
    tick = 300; instance.captureException(retry);
    expect(instance.getDiagnostics()).toMatchObject({ queued: 2, deduplicated: 4 });
  });

  it('is inert for disabled, SSR and destroyed clients and clears cache on destroy', () => {
    const disabled = client({ enabled: false, dedupeIntervalMs: 100 });
    disabled.instance.captureException('same');
    vi.stubGlobal('window', undefined);
    const ssr = client({ dedupeIntervalMs: 100 });
    ssr.instance.captureException('same');
    vi.unstubAllGlobals();
    const active = client({ dedupeIntervalMs: 100 });
    active.instance.captureException('same');
    active.instance.destroy();
    active.instance.captureException('same');
    expect((active.instance as unknown as { dedupeCache: Map<string, number> }).dedupeCache.size).toBe(0);
    expect(active.instance.getDiagnostics().deduplicated).toBe(0);
    expect(disabled.instance.getDiagnostics().queued).toBe(0);
    expect(ssr.instance.getDiagnostics().queued).toBe(0);
  });

  it('does not enqueue or refill the cache when beforeSend destroys the client', async () => {
    let instance!: BrowserErrorLogDiagnosticsClient;
    const transport = vi.fn();
    const result = client({ dedupeIntervalMs: 1000, transport,
      beforeSend: event => { instance.destroy(); return event; } });
    instance = result.instance;
    instance.captureException('destroy in hook');
    await instance.flush();
    expect(instance.getDiagnostics()).toMatchObject({ queued: 0, inFlight: 0, sent: 0,
      deduplicated: 0, dropped: 0 });
    expect((instance as unknown as { dedupeCache: Map<string, number> }).dedupeCache.size).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });
});
