import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, type BrowserErrorLogDiagnostics, type BrowserErrorLogDiagnosticsClient } from './index';

const clients: BrowserErrorLogDiagnosticsClient[] = [];
const zeroReasons = { rateLimit: 0, queueOverflow: 0, payloadTooLarge: 0,
  processingError: 0, deliveryError: 0, destroyed: 0 };

function client(overrides: Partial<Parameters<typeof init>[0]> = {}) {
  const instance = init({ project: 'test', transport: () => {}, captureNetwork: false, ...overrides });
  clients.push(instance);
  return instance;
}

function diagnostics(instance: BrowserErrorLogDiagnosticsClient): BrowserErrorLogDiagnostics {
  const snapshot = instance.getDiagnostics();
  expect(Object.values(snapshot.droppedByReason).reduce((sum, count) => sum + count, 0)).toBe(snapshot.dropped);
  expect(instance.getStats()).toEqual({ queued: snapshot.queued, sent: snapshot.sent, dropped: snapshot.dropped });
  return snapshot;
}

afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('local diagnostics', () => {
  it('starts at zero and returns detached snapshots for independent clients', () => {
    const first = client();
    const second = client();
    const initial = diagnostics(first);
    expect(initial).toEqual({ queued: 0, sent: 0, dropped: 0, inFlight: 0,
      filtered: 0, deduplicated: 0, droppedByReason: zeroReasons });
    initial.queued = 99;
    initial.droppedByReason.rateLimit = 99;
    first.captureException('one');
    expect(diagnostics(first).queued).toBe(1);
    expect(diagnostics(first).droppedByReason).toEqual(zeroReasons);
    expect(diagnostics(second)).toEqual({ queued: 0, sent: 0, dropped: 0, inFlight: 0,
      filtered: 0, deduplicated: 0, droppedByReason: zeroReasons });
  });

  it('counts vetoes and repeated Error objects separately', () => {
    const instance = client({ beforeSend: event => event.message === 'filter' ? false : event });
    const error = new Error('kept');
    instance.captureException('filter');
    instance.captureException(error);
    instance.captureException(error);
    expect(diagnostics(instance)).toMatchObject({ queued: 1, filtered: 1, deduplicated: 1,
      dropped: 0, droppedByReason: zeroReasons });
  });

  it('attributes both rate limit gates once, even with nested beforeSend capture', () => {
    let instance!: BrowserErrorLogDiagnosticsClient;
    instance = client({ maxEventsPerMinute: 1, beforeSend: event => {
      if (event.message === 'outer') instance.captureException('inner');
      return event;
    } });
    instance.captureException('outer');
    instance.captureException('limited');
    expect(diagnostics(instance)).toMatchObject({ queued: 1, dropped: 2,
      droppedByReason: { ...zeroReasons, rateLimit: 2 } });
  });

  it('attributes queue eviction while an earlier event remains in flight', async () => {
    let release!: () => void;
    const transport = vi.fn(() => transport.mock.calls.length === 1
      ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const instance = client({ maxQueueSize: 1, transport });
    instance.captureException('first');
    expect(diagnostics(instance).inFlight).toBe(1);
    instance.captureException('second');
    instance.captureException('third');
    expect(diagnostics(instance)).toMatchObject({ queued: 1, inFlight: 1, dropped: 1,
      droppedByReason: { ...zeroReasons, queueOverflow: 1 } });
    release();
    await Promise.resolve();
    await instance.flush();
  });

  it('counts failed delivery per event only after the final result', async () => {
    const instance = client({ transport: () => { throw { status: 400 }; } });
    instance.captureException('one');
    instance.captureException('two');
    await instance.flush();
    expect(diagnostics(instance)).toMatchObject({ dropped: 2, sent: 0,
      droppedByReason: { ...zeroReasons, deliveryError: 2 } });
  });

  it('does not count a transient failed attempt if retry succeeds', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const instance = client({ transport: () => { if (++attempts === 1) throw { status: 503 }; } });
    instance.captureException('retry');
    const flushing = instance.flush();
    await vi.advanceTimersByTimeAsync(250);
    await flushing;
    expect(attempts).toBe(2);
    expect(diagnostics(instance)).toMatchObject({ sent: 1, dropped: 0,
      droppedByReason: zeroReasons });
  });

  it('counts each event once after exhausted retries', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(() => { throw { status: 503 }; });
    const instance = client({ transport });
    instance.captureException('one');
    instance.captureException('two');
    const flushing = instance.flush();
    await vi.advanceTimersByTimeAsync(750);
    await flushing;
    expect(transport).toHaveBeenCalledTimes(3);
    expect(diagnostics(instance)).toMatchObject({ dropped: 2,
      droppedByReason: { ...zeroReasons, deliveryError: 2 } });
  });

  it('counts queued and in-flight cancellation once on destroy', async () => {
    let reject!: (reason: unknown) => void;
    const instance = client({ maxQueueSize: 1, transport: () => new Promise<void>((_resolve, fail) => { reject = fail; }) });
    instance.captureException('sending');
    instance.captureException('queued');
    const flushing = instance.flush();
    instance.destroy();
    expect(diagnostics(instance)).toMatchObject({ queued: 0, inFlight: 0, dropped: 2,
      droppedByReason: { ...zeroReasons, destroyed: 2 } });
    reject(new Error('late failure'));
    await flushing;
    instance.destroy();
    expect(diagnostics(instance).droppedByReason).toEqual({ ...zeroReasons, destroyed: 2 });
  });

  it('counts escaped oversize event payloads', () => {
    const instance = client({ beforeSend: event => {
      event.context = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field${index}`, '\0'.repeat(500)]));
      event.stack = '\0'.repeat(4096);
      return event;
    } });
    instance.captureException('too large');
    expect(diagnostics(instance)).toMatchObject({ queued: 0, dropped: 1,
      droppedByReason: { ...zeroReasons, payloadTooLarge: 1 } });
  });

  it('attributes an event that fits alone but exceeds the batch envelope', () => {
    const instance = client();
    instance.captureException('candidate');
    const internal = instance as unknown as { queue: Array<{ message: string }>; takeBatch(): { events: unknown[] } };
    const event = internal.queue[0];
    const emptyEnvelopeBytes = new TextEncoder().encode('{"schemaVersion":1,"events":[]}').length;
    const baseBytes = new TextEncoder().encode(JSON.stringify(event)).length - event.message.length;
    event.message = 'x'.repeat(48_000 - baseBytes - emptyEnvelopeBytes + 1);
    expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThanOrEqual(48_000);
    expect(internal.takeBatch().events).toHaveLength(0);
    expect(diagnostics(instance)).toMatchObject({ queued: 0, dropped: 1,
      droppedByReason: { ...zeroReasons, payloadTooLarge: 1 } });
  });

  it('attributes failed manual and global sanitization, context, and beforeSend hooks', () => {
    const context = client({ getContext: () => { throw new Error('context'); } });
    context.captureException('manual');
    expect(diagnostics(context).droppedByReason.processingError).toBe(1);
    const sanitizer = client({ sanitizeUrl: () => { throw new Error('sanitizer'); } });
    sanitizer.captureException('https://example.test/private');
    window.dispatchEvent(new ErrorEvent('error', { filename: 'https://example.test/private', message: 'global' }));
    expect(diagnostics(sanitizer).droppedByReason.processingError).toBe(2);
    const hook = client({ beforeSend: () => { throw new Error('hook'); } });
    hook.captureException('manual');
    expect(diagnostics(hook).droppedByReason.processingError).toBe(1);
  });

  it('attributes console and selected network hook failures without counting unselected HTTP', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleClient = client({ captureConsole: true, sanitizeUrl: () => { throw new Error('unsafe'); } });
    console.error('https://example.test/private');
    expect(diagnostics(consoleClient).droppedByReason.processingError).toBe(1);
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal('fetch', fetch);
    const networkClient = client({ captureNetwork: true, endpoint: '/collector',
      shouldCaptureHttp: () => { throw new Error('hook'); } });
    await window.fetch('/failed');
    expect(diagnostics(networkClient).droppedByReason.processingError).toBe(1);
    const ignored = client({ captureNetwork: true, endpoint: '/collector', shouldCaptureHttp: () => false });
    await window.fetch('/ignored');
    expect(diagnostics(ignored).dropped).toBe(0);
  });

  it.each([true, false])('preserves accepted=%s beacon accounting', accepted => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => accepted) });
    const instance = client({ transport: undefined, endpoint: '/collector' });
    instance.captureException('beacon');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(diagnostics(instance)).toMatchObject({ queued: accepted ? 0 : 1,
      sent: accepted ? 1 : 0, dropped: 0, droppedByReason: zeroReasons });
  });

  it('keeps inactive clients at zero and retains counters after destroy', () => {
    const disabled = client({ enabled: false });
    vi.stubGlobal('window', undefined);
    const server = client();
    vi.unstubAllGlobals();
    disabled.captureException('ignored');
    server.captureException('ignored');
    expect(diagnostics(disabled).droppedByReason).toEqual(zeroReasons);
    expect(diagnostics(server).droppedByReason).toEqual(zeroReasons);
    const active = client();
    active.captureException('pending');
    active.destroy();
    active.captureException('ignored');
    expect(diagnostics(active)).toMatchObject({ dropped: 1, queued: 0, inFlight: 0,
      droppedByReason: { ...zeroReasons, destroyed: 1 } });
  });
});
