import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogOptions, type BrowserErrorLogDiagnosticsClient } from './index';

const clients: BrowserErrorLogDiagnosticsClient[] = [];

function client(overrides: Partial<BrowserErrorLogOptions> = {}) {
  const transport = vi.fn((_batch: EventBatch) => {});
  const instance = init({ project: 'web', captureNetwork: false, transport, ...overrides });
  clients.push(instance);
  return { instance, transport };
}

afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pauseWhileOffline', () => {
  it('holds manual, interval, and full-queue flushes until the online event, with bounded overflow', async () => {
    vi.useFakeTimers();
    let onLine = false;
    vi.stubGlobal('navigator', { get onLine() { return onLine; } });
    const { instance, transport } = client({ pauseWhileOffline: true, flushIntervalMs: 10, maxQueueSize: 2 });

    instance.captureException('one');
    await instance.flush();
    await vi.advanceTimersByTimeAsync(30);
    instance.captureException('two');
    instance.captureException('three');
    await instance.flush();
    expect(transport).not.toHaveBeenCalled();
    expect(instance.getDiagnostics()).toMatchObject({ queued: 2, inFlight: 0, sent: 0, dropped: 1,
      droppedByReason: { queueOverflow: 1, deliveryError: 0 } });

    window.dispatchEvent(new Event('online'));
    expect(transport).not.toHaveBeenCalled();

    onLine = true;
    window.dispatchEvent(new Event('online'));
    expect(transport).toHaveBeenCalledTimes(1);
    await instance.flush();
    expect(transport.mock.calls[0][0].events.map(event => event.message)).toEqual(['two', 'three']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 1 });
  });

  it('keeps default-off delivery and beacon behavior without reading connectivity or listening online', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const sendBeacon = vi.fn(() => true);
    let reads = 0;
    vi.stubGlobal('navigator', { sendBeacon, get onLine() { reads++; throw new Error('hostile status'); } });
    const { instance, transport } = client();
    instance.captureException('default delivery');
    await instance.flush();
    expect(transport).toHaveBeenCalledTimes(1);

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const native = client({ transport: undefined, endpoint: '/collect' });
    native.instance.captureException('default beacon');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(native.instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
    expect(reads).toBe(0);
    expect(add.mock.calls.filter(([name]) => name === 'online')).toHaveLength(0);
  });

  it.each([undefined, true, 'false', 0, null, 'throw', 'no navigator'])(
    'fails open when navigator.onLine is %s', async value => {
      if (value === 'no navigator') vi.stubGlobal('navigator', undefined);
      else if (value === undefined) vi.stubGlobal('navigator', {});
      else vi.stubGlobal('navigator', {
        get onLine() { if (value === 'throw') throw new Error('unavailable'); return value; },
      });
      const { instance, transport } = client({ pauseWhileOffline: true });
      instance.captureException('deliver');
      await instance.flush();
      expect(transport).toHaveBeenCalledTimes(1);
      expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
    },
  );

  it('snapshots strict-true opt-in at init', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const transport = vi.fn();
    const options: BrowserErrorLogOptions = { project: 'web', captureNetwork: false, transport, pauseWhileOffline: true };
    const paused = init(options);
    clients.push(paused);
    options.pauseWhileOffline = false;
    paused.captureException('still held');
    await paused.flush();
    expect(transport).not.toHaveBeenCalled();
    expect(paused.getStats().queued).toBe(1);

    const optOut = client({ pauseWhileOffline: 'true' as unknown as boolean });
    optOut.instance.captureException('not opted in');
    await optOut.instance.flush();
    expect(optOut.transport).toHaveBeenCalledTimes(1);
  });

  it('resumes a paused drain when online arrives before its flush promise settles', async () => {
    let onLine = false;
    vi.stubGlobal('navigator', { get onLine() { return onLine; } });
    const { instance, transport } = client({ pauseWhileOffline: true });
    instance.captureException('race');
    const paused = instance.flush();
    onLine = true;
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    await paused;
    await Promise.resolve();
    expect(transport).toHaveBeenCalledTimes(1);
    await instance.flush();
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
  });

  it('coalesces online events with an active batch without concurrent sends', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    let release!: () => void;
    let active = 0;
    let peak = 0;
    const batches: string[][] = [];
    const transport = vi.fn(async (batch: EventBatch) => {
      active++;
      peak = Math.max(peak, active);
      batches.push(batch.events.map(event => event.message));
      if (batches.length === 1) await new Promise<void>(resolve => { release = resolve; });
      active--;
    });
    const { instance } = client({ pauseWhileOffline: true, transport });
    instance.captureException('first');
    const pending = instance.flush();
    instance.captureException('second');
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    expect(transport).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(batches).toEqual([['first'], ['second']]);
    expect(peak).toBe(1);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 0 });
  });

  it('keeps synchronous online reentry inside the first transport on the same drain', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    let releaseFirst!: () => void;
    let active = 0;
    let peak = 0;
    const batches: string[][] = [];
    const transport = vi.fn((batch: EventBatch) => {
      active++;
      peak = Math.max(peak, active);
      batches.push(batch.events.map(event => event.message));
      if (batches.length === 1) {
        window.dispatchEvent(new Event('online'));
        return new Promise<void>(resolve => { releaseFirst = () => { active--; resolve(); }; });
      }
      active--;
    });
    const { instance } = client({ pauseWhileOffline: true, transport });
    for (let index = 0; index < 21; index++) instance.captureException(`event ${index}`);

    const pending = instance.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(peak).toBe(1);
    expect(batches).toEqual([Array.from({ length: 20 }, (_, index) => `event ${index}`)]);
    releaseFirst();
    await pending;
    expect(batches).toEqual([
      Array.from({ length: 20 }, (_, index) => `event ${index}`),
      ['event 20'],
    ]);
    expect(peak).toBe(1);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 21, dropped: 0 });
  });

  it('preserves filtering, dedupe, rate capacity, and drop diagnostics while offline', async () => {
    let onLine = false;
    vi.stubGlobal('navigator', { get onLine() { return onLine; } });
    const { instance, transport } = client({ pauseWhileOffline: true, maxQueueSize: 2,
      maxEventsPerMinute: 3, dedupeIntervalMs: 60_000,
      beforeSend: event => event.message === 'filtered' ? false : event });
    for (const message of ['one', 'one', 'filtered', 'two', 'three', 'four']) instance.captureException(message);
    await instance.flush();
    expect(transport).not.toHaveBeenCalled();
    expect(instance.getDiagnostics()).toMatchObject({ queued: 2, sent: 0, dropped: 2,
      filtered: 1, deduplicated: 1,
      droppedByReason: { rateLimit: 1, queueOverflow: 1, deliveryError: 0 } });

    onLine = true;
    window.dispatchEvent(new Event('online'));
    await instance.flush();
    expect(transport.mock.calls[0][0].events.map(event => event.message)).toEqual(['two', 'three']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 2 });
  });

  it('keeps native beacon and fetch queued offline, then resumes fetch on online', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    let onLine = false;
    const sendBeacon = vi.fn(() => true);
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('navigator', { get onLine() { return onLine; }, sendBeacon });
    vi.stubGlobal('fetch', fetch);
    const { instance } = client({ pauseWhileOffline: true, transport: undefined, endpoint: '/collect' });
    instance.captureException('held');
    document.dispatchEvent(new Event('visibilitychange'));
    await instance.flush();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(instance.getStats()).toEqual({ queued: 1, sent: 0, dropped: 0 });

    onLine = true;
    window.dispatchEvent(new Event('online'));
    expect(fetch).toHaveBeenCalledTimes(1);
    await instance.flush();
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
    instance.captureException('beacon online');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 0 });
  });

  it('finishes an in-flight retry offline and leaves the next batch queued', async () => {
    vi.useFakeTimers();
    let onLine = true;
    vi.stubGlobal('navigator', { get onLine() { return onLine; } });
    const transport = vi.fn((batch: EventBatch) => {
      if (transport.mock.calls.length === 1) {
        expect(batch.events).toHaveLength(20);
        onLine = false;
        throw { status: 503 };
      }
    });
    const { instance } = client({ pauseWhileOffline: true, transport });
    for (let index = 0; index < 21; index++) instance.captureException(`event ${index}`);
    const pending = instance.flush();
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.map(([batch]) => batch.events.length)).toEqual([20, 20]);
    expect(instance.getDiagnostics()).toMatchObject({ queued: 1, inFlight: 0, sent: 20, dropped: 0,
      droppedByReason: { deliveryError: 0 } });

    onLine = true;
    window.dispatchEvent(new Event('online'));
    expect(transport).toHaveBeenCalledTimes(3);
    await instance.flush();
    expect(transport.mock.calls[2][0].events.map(event => event.message)).toEqual(['event 20']);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 21, dropped: 0 });
  });

  it('removes the online listener on destroy and counts queued cancellation once', async () => {
    let onLine = false;
    vi.stubGlobal('navigator', { get onLine() { return onLine; } });
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { instance, transport } = client({ pauseWhileOffline: true });
    const onlineAdd = add.mock.calls.filter(([name]) => name === 'online');
    expect(onlineAdd).toHaveLength(1);
    instance.captureException('cancel');
    instance.destroy();
    const onlineRemove = remove.mock.calls.filter(([name]) => name === 'online');
    expect(onlineRemove).toHaveLength(1);
    expect(onlineRemove[0][1]).toBe(onlineAdd[0][1]);
    onLine = true;
    window.dispatchEvent(new Event('online'));
    await instance.flush();
    expect(transport).not.toHaveBeenCalled();
    expect(instance.getDiagnostics()).toMatchObject({ queued: 0, inFlight: 0, sent: 0, dropped: 1,
      droppedByReason: { destroyed: 1 } });
  });

  it('keeps disabled and server clients inert without connectivity reads or online listeners', async () => {
    let reads = 0;
    vi.stubGlobal('navigator', { get onLine() { reads++; return false; } });
    const add = vi.spyOn(window, 'addEventListener');
    const disabled = client({ enabled: false, pauseWhileOffline: true });
    disabled.instance.captureException('disabled');
    await disabled.instance.flush();
    expect(disabled.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });

    vi.stubGlobal('window', undefined);
    const server = client({ pauseWhileOffline: true });
    server.instance.captureException('server');
    await server.instance.flush();
    expect(server.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    vi.unstubAllGlobals();
    expect(reads).toBe(0);
    expect(add.mock.calls.filter(([name]) => name === 'online')).toHaveLength(0);
  });
});
