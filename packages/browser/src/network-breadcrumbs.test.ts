import { afterEach, describe, expect, it, vi } from 'vitest';
import { BREADCRUMB_LIMITS, isBreadcrumbTrail, type EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogBreadcrumbClient, type BrowserErrorLogOptions } from './index';

const clients: BrowserErrorLogBreadcrumbClient[] = [];

function client(overrides: Partial<BrowserErrorLogOptions> = {}) {
  const batches: EventBatch[] = [];
  const instance = init({ project: 'network-test', transport: batch => { batches.push(batch); },
    captureNetwork: false, ...overrides });
  clients.push(instance);
  return { instance, batches };
}

function crumbs(batches: EventBatch[]) {
  return batches[0].events[0].breadcrumbs;
}

afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('opt-in network breadcrumbs', () => {
  it('is off by default and records successful and 404 fetches without standalone errors when enabled alone', async () => {
    const native = vi.fn((url: string) => Promise.resolve(new Response(null, { status: url.includes('missing') ? 404 : 200 })));
    vi.stubGlobal('fetch', native);
    const off = client();
    expect(window.fetch).toBe(native);
    off.instance.destroy();

    const shouldCaptureHttp = vi.fn(() => { throw new Error('must not run'); });
    const { instance, batches } = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector', shouldCaptureHttp });
    await window.fetch('/ok?token=secret#section');
    await window.fetch('/missing?token=secret');
    expect(instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    expect(shouldCaptureHttp).not.toHaveBeenCalled();
    instance.captureException(new Error('later'));
    await instance.flush();
    expect(batches[0].events).toHaveLength(1);
    expect(crumbs(batches)).toMatchObject([
      { category: 'http', message: 'HTTP response', data: { method: 'GET', url: 'http://localhost:3000/ok', status: 200 } },
      { category: 'http', message: 'HTTP response', data: { method: 'GET', url: 'http://localhost:3000/missing', status: 404 } },
    ]);
    expect(JSON.stringify(batches)).not.toMatch(/token=|#section/);
    expect(isBreadcrumbTrail(crumbs(batches))).toBe(true);
  });

  it('records 5xx and failed transport crumbs in completion order without queuing errors in crumb-only mode', async () => {
    let resolveSlow!: (response: Response) => void;
    let rejectFailed!: (reason: unknown) => void;
    const failure = new TypeError('private failure message');
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('slow')
      ? new Promise<Response>(resolve => { resolveSlow = resolve; })
      : url.includes('failed')
        ? new Promise<Response>((_resolve, reject) => { rejectFailed = reject; })
        : Promise.resolve(new Response(null, { status: 503 }))));
    const { instance, batches } = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector' });
    const slow = window.fetch('/slow');
    const failed = window.fetch('/failed');
    await window.fetch('/fast');
    rejectFailed(failure);
    await expect(failed).rejects.toBe(failure);
    resolveSlow(new Response(null, { status: 200 }));
    await slow;
    expect(instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    instance.captureException(new Error('later'));
    await instance.flush();
    expect(crumbs(batches)?.map(item => [item.category, item.message, item.data?.url, item.data?.status])).toEqual([
      ['http', 'HTTP response', 'http://localhost:3000/fast', 503],
      ['network', 'Network failure', 'http://localhost:3000/failed', undefined],
      ['http', 'HTTP response', 'http://localhost:3000/slow', 200],
    ]);
    expect(JSON.stringify(batches)).not.toContain('private failure message');
  });

  it('puts a 5xx crumb into its own standalone event and does not let an HTTP predicate veto crumbs', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('offline')
      ? Promise.reject(new TypeError('offline')) : Promise.resolve(new Response(null, { status: 503 }))));
    const { instance, batches } = client({ captureNetwork: true, captureNetworkBreadcrumbs: true,
      endpoint: '/collector', shouldCaptureHttp: status => status === 503 });
    await window.fetch('/failure');
    await expect(window.fetch('/offline')).rejects.toThrow('offline');
    await instance.flush();
    expect(batches[0].events).toHaveLength(2);
    expect(batches[0].events[0].type).toBe('http');
    expect(batches[0].events[0].breadcrumbs?.at(-1)?.data).toMatchObject({ status: 503, url: 'http://localhost:3000/failure' });
    expect(batches[0].events[1].type).toBe('network');
    expect(batches[0].events[1].breadcrumbs?.at(-1)?.data).toMatchObject({ url: 'http://localhost:3000/offline' });

    instance.clearBreadcrumbs();
    const veto = client({ captureNetwork: true, captureNetworkBreadcrumbs: true, endpoint: '/collector',
      shouldCaptureHttp: () => false });
    await window.fetch('/veto');
    expect(veto.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    veto.instance.captureException(new Error('later'));
    await veto.instance.flush();
    expect(crumbs(veto.batches)?.[0].data?.url).toBe('http://localhost:3000/veto');
  });

  it('fails closed when an active HTTP predicate throws, without adding its crumb', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))));
    const { instance, batches } = client({ captureNetwork: true, captureNetworkBreadcrumbs: true,
      endpoint: '/collector', shouldCaptureHttp: () => { throw new Error('unsafe'); } });
    await window.fetch('/failure');
    expect(instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 1 });
    instance.captureException(new Error('later'));
    await instance.flush();
    expect(crumbs(batches)).toBeUndefined();
    expect(batches[0].events).toHaveLength(1);
  });

  it('preserves native fetch receiver, arguments, response, and rejection without reading bodies or headers', async () => {
    const failure = new TypeError('private failure');
    const response = { status: 0, get body(): never { throw new Error('body read'); },
      get headers(): never { throw new Error('headers read'); } } as unknown as Response;
    const initOptions = { method: 'post', get body(): never { throw new Error('body read'); },
      get headers(): never { throw new Error('headers read'); } } as RequestInit;
    const native = vi.fn(function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      expect(this).toBe(window);
      expect(args[1]).toBe(initOptions);
      return String(args[0]).includes('fail') ? Promise.reject(failure) : Promise.resolve(response);
    });
    vi.stubGlobal('fetch', native);
    const { instance, batches } = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector' });
    expect(await window.fetch('/zero', initOptions)).toBe(response);
    await expect(window.fetch('/fail', initOptions)).rejects.toBe(failure);
    expect(native.mock.calls).toEqual([['/zero', initOptions], ['/fail', initOptions]]);
    instance.captureException(new Error('later'));
    await instance.flush();
    expect(crumbs(batches)?.map(item => item.data)).toMatchObject([
      { method: 'POST', url: 'http://localhost:3000/zero', status: 0 },
      { method: 'POST', url: 'http://localhost:3000/fail' },
    ]);
  });

  it('excludes collector requests and intentional aborts, and requires an endpoint for a custom transport', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const native = vi.fn((url: string) => url.includes('abort') ? Promise.reject(abort)
      : Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal('fetch', native);
    const unnamed = client({ captureNetworkBreadcrumbs: true, captureNetwork: true });
    expect(window.fetch).toBe(native);
    await window.fetch('/without-endpoint');
    unnamed.instance.captureException(new Error('later'));
    await unnamed.instance.flush();
    expect(crumbs(unnamed.batches)).toBeUndefined();

    const { instance, batches } = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector' });
    await window.fetch('/collector?token=hidden');
    await expect(window.fetch('/abort')).rejects.toBe(abort);
    instance.captureException(new Error('later'));
    await instance.flush();
    expect(crumbs(batches)).toBeUndefined();
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
  });

  it('accepts only bounded, valid sanitized HTTP URLs and does not inflate stats for unsafe crumb-only URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ status: Infinity } as Response)));
    const { instance, batches } = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector',
      sanitizeUrl: url => url.includes('invalid') ? 'http://user:secret@bad host/path?token=hidden'
        : url.includes('unsupported') ? 'ftp://host/private?token=hidden'
          : `https://user:secret@example.test/${'x'.repeat(300)}?token=hidden#fragment` });
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(5_000_000);
    await window.fetch('/long', { method: 'GET /secret?token=hidden' });
    clock.mockRestore();
    await window.fetch('/invalid');
    await window.fetch('/unsupported');
    expect(instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    instance.captureException(new Error('later'));
    await instance.flush();
    const data = crumbs(batches)?.[0].data;
    expect(crumbs(batches)).toHaveLength(1);
    expect(data?.method).toBe('GET');
    expect(data?.url).toHaveLength(BREADCRUMB_LIMITS.dataString);
    expect(data?.durationMs).toBe(3_600_000);
    expect(data?.status).toBeUndefined();
    expect(JSON.stringify(batches)).not.toMatch(/user:secret|token=hidden|#fragment/);
  });

  it('drops a selected error once for a failing URL sanitizer while a crumb-only failure stays statistic-free', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))));
    const sanitizer = (url: string) => {
      if (url.includes('/throw')) throw new Error('sanitizer failed');
      return url.includes('/bad') ? 'http://user:secret@bad host/path?token=hidden' : url;
    };
    const crumbOnly = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector', sanitizeUrl: sanitizer });
    const both = client({ captureNetworkBreadcrumbs: true, captureNetwork: true, endpoint: '/collector', sanitizeUrl: sanitizer });
    await window.fetch('/bad');
    await window.fetch('/throw');
    expect(crumbOnly.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    expect(both.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 2 });
    crumbOnly.instance.captureException(new Error('later'));
    await crumbOnly.instance.flush();
    expect(crumbs(crumbOnly.batches)).toBeUndefined();
    expect(JSON.stringify(crumbOnly.batches)).not.toContain('user:secret');
  });

  it('captures XHR completion and failure, then clears pending work on reopen and abort', async () => {
    class FakeXHR extends EventTarget {
      status = 200;
      active = false;
      open(_method: string, _url: string): void { this.active = false; }
      send(): void { if (this.active) throw new Error('already sent'); this.active = true; }
      finish(status: number, kind: 'load' | 'error' | 'abort' = 'load'): void {
        this.status = status;
        this.active = false;
        this.dispatchEvent(new Event(kind));
        this.dispatchEvent(new Event('loadend'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const { instance, batches } = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector' });
    const xhr = new XMLHttpRequest() as XMLHttpRequest & FakeXHR;
    const onload = vi.fn();
    xhr.addEventListener('load', onload);
    xhr.open('GET', '/old'); xhr.send();
    xhr.open('POST', '/new?token=secret'); xhr.send(); xhr.finish(200);
    xhr.open('GET', '/zero'); xhr.send(); xhr.finish(0);
    xhr.open('GET', '/offline'); xhr.send(); xhr.finish(0, 'error');
    xhr.open('GET', '/cancelled'); xhr.send(); xhr.finish(0, 'abort');
    expect(onload).toHaveBeenCalledTimes(2);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    instance.captureException(new Error('later'));
    await instance.flush();
    expect(crumbs(batches)?.map(item => [item.category, item.data?.method, item.data?.url, item.data?.status])).toEqual([
      ['http', 'POST', 'http://localhost:3000/new', 200],
      ['http', 'GET', 'http://localhost:3000/zero', 0],
      ['network', 'GET', 'http://localhost:3000/offline', undefined],
    ]);
  });

  it('records successful XHR status 0 only as a crumb even when HTTP error capture is enabled', async () => {
    class FakeXHR extends EventTarget {
      status = 0;
      open(_method: string, _url: string): void {}
      send(): void {
        this.dispatchEvent(new Event('load'));
        this.dispatchEvent(new Event('loadend'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const select = vi.fn(() => true);
    const throwing = vi.fn(() => { throw new Error('predicate failed'); });
    const selected = client({ captureNetwork: true, captureNetworkBreadcrumbs: true,
      endpoint: '/collector', shouldCaptureHttp: select });
    const failedPredicate = client({ captureNetwork: true, captureNetworkBreadcrumbs: true,
      endpoint: '/collector', shouldCaptureHttp: throwing });
    const legacy = client({ captureNetwork: true, endpoint: '/collector', shouldCaptureHttp: select });
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/zero?token=hidden');
    xhr.send();
    expect(select).not.toHaveBeenCalled();
    expect(throwing).not.toHaveBeenCalled();
    for (const item of [selected, failedPredicate, legacy]) {
      expect(item.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    }
    selected.instance.captureException(new Error('selected later'));
    failedPredicate.instance.captureException(new Error('predicate later'));
    legacy.instance.captureException(new Error('legacy later'));
    await Promise.all([selected.instance.flush(), failedPredicate.instance.flush(), legacy.instance.flush()]);
    for (const item of [selected, failedPredicate]) {
      expect(item.batches[0].events.map(event => event.type)).toEqual(['manual']);
      expect(crumbs(item.batches)?.[0]).toMatchObject({ category: 'http', message: 'HTTP response',
        data: { url: 'http://localhost:3000/zero', status: 0 } });
      expect(item.instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
    }
    expect(crumbs(legacy.batches)).toBeUndefined();
  });

  it('shares wrappers across clients, preserves a foreign fetch wrapper, and respects disabled, server, destroyed, clear and snapshots', async () => {
    const native = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal('fetch', native);
    const disabled = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector', enabled: false });
    expect(window.fetch).toBe(native);
    const browserWindow = window;
    vi.stubGlobal('window', undefined);
    const server = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector' });
    vi.stubGlobal('window', browserWindow);
    expect(browserWindow.fetch).toBe(native);
    const first = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector' });
    const sdkWrapper = window.fetch;
    const second = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector', beforeSend: event => {
      if (event.message === 'removed') event.breadcrumbs = undefined;
      return event;
    } });
    expect(window.fetch).toBe(sdkWrapper);
    await window.fetch('/one');
    first.instance.captureException(new Error('snapshot'));
    first.instance.clearBreadcrumbs();
    first.instance.captureException(new Error('cleared'));
    second.instance.captureException(new Error('removed'));
    second.instance.captureException(new Error('kept'));
    await Promise.all([first.instance.flush(), second.instance.flush()]);
    expect(first.batches[0].events[0].breadcrumbs?.[0].data?.url).toBe('http://localhost:3000/one');
    expect(first.batches[0].events[1].breadcrumbs).toBeUndefined();
    expect(second.batches[0].events[0].breadcrumbs).toBeUndefined();
    expect(second.batches[0].events[1].breadcrumbs?.[0].data?.url).toBe('http://localhost:3000/one');
    first.instance.destroy();
    expect(window.fetch).toBe(sdkWrapper);
    await window.fetch('/two');
    second.instance.captureException(new Error('after first destroyed'));
    await second.instance.flush();
    expect(second.batches[1].events[0].breadcrumbs?.at(-1)?.data?.url).toBe('http://localhost:3000/two');
    const foreign = vi.fn(function (this: typeof window, ...args: Parameters<typeof fetch>) {
      return Reflect.apply(sdkWrapper, this, args);
    });
    window.fetch = foreign;
    second.instance.destroy();
    expect(window.fetch).toBe(foreign);
    await window.fetch('/three');
    expect(native).toHaveBeenCalledTimes(3);
    expect(first.instance.getStats().sent).toBe(2);
    expect(disabled.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    expect(server.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
  });
});
