import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from 'browser-error-log-protocol';
import { init, type BrowserErrorLogClient } from './index';

const clients: BrowserErrorLogClient[] = [];
const captured: EventBatch[] = [];

function client(overrides: Partial<Parameters<typeof init>[0]> = {}): BrowserErrorLogClient {
  const instance = init({
    project: 'web',
    environment: 'test',
    release: '1.0.0',
    transport: batch => { captured.push(JSON.parse(JSON.stringify(batch)) as EventBatch); },
    captureNetwork: false,
    ...overrides,
  });
  clients.push(instance);
  return instance;
}

beforeEach(() => { captured.length = 0; });
afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('browser error client', () => {
  it('is inert when disabled or rendered on the server', async () => {
    const disabled = client({ enabled: false, transport: undefined });
    disabled.captureException(new Error('ignored'));
    await disabled.flush();
    expect(disabled.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });

    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    const server = init({ project: 'web' });
    server.captureException(new Error('server'));
    await server.flush();
    expect(server.getStats().queued).toBe(0);
    server.destroy();
  });

  it('preserves fetch response, rejection reason, and native this while recording failures', async () => {
    const reason = new TypeError('Failed to fetch');
    const ok = new Response('unmodified', { status: 503 });
    const native = vi.fn(function (this: unknown, input: RequestInfo | URL): Promise<Response> {
      expect(this).toBe(window);
      return String(input).includes('reject') ? Promise.reject(reason) : Promise.resolve(ok);
    });
    vi.stubGlobal('fetch', native);
    const instance = client({ captureNetwork: true, endpoint: '/collector' });
    const response = await window.fetch('/failure?token=private');
    expect(response).toBe(ok);
    expect(await response.text()).toBe('unmodified');
    await expect(window.fetch('/reject')).rejects.toBe(reason);
    await instance.flush();
    expect(captured[0].events.map(event => event.type)).toEqual(['http', 'network']);
    expect(captured[0].events[0].network).toMatchObject({ method: 'GET', status: 503 });
    expect(captured[0].events[0].network?.url).not.toContain('token=private');
    expect(native).toHaveBeenCalledTimes(2);
  });

  it('records only selected HTTP statuses and ignores intentional fetch aborts', async () => {
    const aborted = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('abort')) return Promise.reject(aborted);
      return Promise.resolve(new Response('', { status: url.includes('bad') ? 503 : 404 }));
    }));
    const instance = client({ captureNetwork: true, endpoint: '/collector', shouldCaptureHttp: status => status === 404 });
    await window.fetch('/bad');
    await window.fetch('/not-found');
    await expect(window.fetch('/abort')).rejects.toBe(aborted);
    await instance.flush();
    expect(captured[0].events).toHaveLength(1);
    expect(captured[0].events[0].network?.status).toBe(404);
  });

  it('captures XHR HTTP failures while preserving handlers and excluding aborts', async () => {
    class FakeXHR extends EventTarget {
      status = 503;
      method = '';
      url = '';
      sendReceiver: unknown;
      open(method: string, url: string): void { this.method = method; this.url = url; }
      send(): void {
        this.sendReceiver = this;
        if (this.url.includes('abort')) {
          this.status = 0;
          this.dispatchEvent(new Event('abort'));
        } else this.dispatchEvent(new Event('load'));
        this.dispatchEvent(new Event('loadend'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const instance = client({ captureNetwork: true, endpoint: '/collector' });
    const xhr = new XMLHttpRequest() as XMLHttpRequest & FakeXHR;
    const onload = vi.fn();
    xhr.addEventListener('load', onload);
    xhr.open('POST', '/save?secret=1');
    xhr.send();
    expect(xhr.sendReceiver).toBe(xhr);
    expect(onload).toHaveBeenCalledTimes(1);
    const aborted = new XMLHttpRequest();
    aborted.open('GET', '/abort');
    aborted.send();
    await instance.flush();
    expect(captured[0].events).toHaveLength(1);
    expect(captured[0].events[0].network).toMatchObject({ method: 'POST', status: 503 });
    expect(captured[0].events[0].network?.url).not.toContain('secret=1');
  });

  it('deduplicates the same Error across global and manual capture', async () => {
    const instance = client();
    const error = new Error('one failure');
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
    instance.captureException(error, { type: 'react' });
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: error });
    window.dispatchEvent(rejection);
    await instance.flush();
    expect(captured[0].events).toHaveLength(1);
    expect(captured[0].events[0].type).toBe('javascript');
  });

  it('redacts sensitive content even when beforeSend mutates the record', async () => {
    const instance = client({
      beforeSend: event => {
        event.message = 'Bearer abc.def jane@example.com https://user:pass@example.com/page?key=hidden#part';
        event.page = 'https://user:pass@example.com/page?key=hidden#part';
        return event;
      },
    });
    instance.captureException(new Error('sensitive'), {
      context: { password: 'secret', authToken: 'secret', note: 'bob@example.com Bearer key123', count: 2, nested: { secret: true } },
    });
    await instance.flush();
    const event = captured[0].events[0];
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/abc\.def|jane@example|bob@example|key123|key=hidden|user:pass|"password"|"authToken"|"nested"/);
    expect(event.context).toMatchObject({ count: 2 });
    expect(event.page).toBe('https://example.com/page');
  });

  it('drops records when a privacy hook throws', async () => {
    const beforeSend = client({ beforeSend: () => { throw new Error('unsafe transform'); } });
    beforeSend.captureException(new Error('private path'));
    await beforeSend.flush();
    expect(beforeSend.getStats()).toMatchObject({ sent: 0, dropped: 1 });

    const sanitizeUrl = client({ sanitizeUrl: () => { throw new Error('unsafe URL'); } });
    sanitizeUrl.captureException(new Error('https://example.com/private?token=secret'));
    await sanitizeUrl.flush();
    expect(sanitizeUrl.getStats()).toMatchObject({ sent: 0, dropped: 1 });
    expect(captured).toHaveLength(0);
  });

  it('keeps stable IDs while retrying 429 and drops permanent 4xx once', async () => {
    vi.useFakeTimers();
    const attempts: EventBatch[] = [];
    const retrying = client({ transport: batch => {
      attempts.push(batch);
      if (attempts.length === 1) throw { status: 429 };
    } });
    retrying.captureException(new Error('retry me'));
    const pending = retrying.flush();
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].events[0].eventId).toBe(attempts[1].events[0].eventId);
    expect(retrying.getStats()).toMatchObject({ sent: 1, dropped: 0 });

    const permanent = vi.fn(() => { throw { status: 400 }; });
    const rejected = client({ transport: permanent });
    rejected.captureException(new Error('bad request'));
    await rejected.flush();
    expect(permanent).toHaveBeenCalledTimes(1);
    expect(rejected.getStats()).toMatchObject({ sent: 0, dropped: 1 });
  });

  it('retries default collector 5xx without collecting its own failed POST', async () => {
    vi.useFakeTimers();
    const bodies: EventBatch[] = [];
    const native = vi.fn((_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as EventBatch);
      return Promise.resolve(new Response(null, { status: bodies.length === 1 ? 503 : 204 }));
    });
    vi.stubGlobal('fetch', native);
    const instance = client({ transport: undefined, endpoint: '/collect', captureNetwork: true });
    instance.captureException(new Error('original failure'));
    const pending = instance.flush();
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(native).toHaveBeenCalledTimes(2);
    expect(bodies.map(batch => batch.events.length)).toEqual([1, 1]);
    expect(bodies[0].events[0].eventId).toBe(bodies[1].events[0].eventId);
    expect(instance.getStats()).toMatchObject({ queued: 0, sent: 1, dropped: 0 });
  });

  it('does not instrument a custom transport without an exclusion endpoint', async () => {
    vi.useFakeTimers();
    const native = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal('fetch', native);
    const transport = vi.fn(async () => {
      const response = await window.fetch('/collect');
      if (!response.ok) throw { status: response.status };
    });
    const instance = client({ captureNetwork: true, transport });
    expect(window.fetch).toBe(native);
    instance.captureException(new Error('original failure'));
    const pending = instance.flush();
    await vi.advanceTimersByTimeAsync(750);
    await pending;
    expect(native).toHaveBeenCalledTimes(3);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(instance.getStats()).toMatchObject({ queued: 0, sent: 0, dropped: 1 });
  });

  it('continues capturing app failures while a named custom transport awaits', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))));
    let releaseFirst!: () => void;
    let calls = 0;
    const transport = vi.fn(() => {
      calls++;
      return calls === 1 ? new Promise<void>(resolve => { releaseFirst = resolve; }) : Promise.resolve();
    });
    const instance = client({ captureNetwork: true, endpoint: '/collector', transport });
    instance.captureException(new Error('first'));
    const pending = instance.flush();
    await window.fetch('/app-failure?token=private');
    expect(instance.getStats().queued).toBe(1);
    releaseFirst();
    await pending;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(instance.getStats()).toMatchObject({ sent: 2, dropped: 0 });
  });

  it('bounds an uncooperative custom transport and aborts each attempt signal', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const rejectLate: Array<(error: Error) => void> = [];
    const transport = vi.fn((_batch: EventBatch, context: { signal: AbortSignal }) => {
      signals.push(context.signal);
      return new Promise<void>((_resolve, reject) => { rejectLate.push(reject); });
    });
    const instance = client({ transport, transportTimeoutMs: 250 });
    instance.captureException(new Error('timeout'));
    const pending = instance.flush();
    await vi.advanceTimersByTimeAsync(1_500);
    await pending;
    expect(transport).toHaveBeenCalledTimes(3);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(instance.getStats()).toMatchObject({ queued: 0, sent: 0, dropped: 1 });
    rejectLate.forEach(reject => reject(new Error('late rejection')));
    await Promise.resolve();
  });

  it('aborts a hung default fetch after its per-attempt deadline', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => {
      signals.push(options!.signal!);
      return new Promise<Response>(() => {});
    }));
    const instance = client({ transport: undefined, endpoint: '/collect', transportTimeoutMs: 250 });
    instance.captureException(new Error('timeout'));
    const pending = instance.flush();
    await vi.advanceTimersByTimeAsync(1_500);
    await pending;
    expect(signals).toHaveLength(3);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(instance.getStats()).toMatchObject({ sent: 0, dropped: 1 });
  });

  it('bounds pending events and ends an unresolved transport on destroy', async () => {
    const transport = vi.fn(() => new Promise<void>(() => {}));
    const instance = client({ transport, maxQueueSize: 2 });
    instance.captureException('one');
    instance.captureException('two');
    const pending = instance.flush();
    instance.captureException('three');
    instance.captureException('four');
    instance.captureException('five');
    expect(instance.getStats()).toMatchObject({ queued: 2, dropped: 1 });
    instance.destroy();
    await pending;
    expect(instance.getStats()).toMatchObject({ queued: 0, dropped: 5 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('restores its wrappers without overwriting a later wrapper', async () => {
    const native = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', native);
    const first = client({ captureNetwork: true, endpoint: '/collector' });
    const sdkWrapper = window.fetch;
    const foreign = vi.fn(function (this: typeof window, ...args: Parameters<typeof fetch>) {
      return Reflect.apply(sdkWrapper, this, args);
    });
    window.fetch = foreign;
    first.destroy();
    expect(window.fetch).toBe(foreign);
    const second = client({ captureNetwork: true, endpoint: '/collector' });
    await window.fetch('/ok');
    await second.flush();
    second.destroy();
    expect(window.fetch).toBe(foreign);
    expect(native).toHaveBeenCalledTimes(1);
  });
});
