import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BREADCRUMB_LIMITS, isBreadcrumbTrail, type EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogClient } from './index';

const clients: BrowserErrorLogClient[] = [];
const captured: EventBatch[] = [];

function client(overrides: Partial<Parameters<typeof init>[0]> = {}): ReturnType<typeof init> {
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
  it('snapshots manual breadcrumbs in order and clears only future events', async () => {
    const instance = client();
    const input = { message: 'step one', data: { state: 'cart' } };
    instance.addBreadcrumb(input);
    input.data.state = 'changed';
    instance.captureException(new Error('first'));
    instance.addBreadcrumb({ category: 'navigation', message: 'step two' });
    instance.captureException(new Error('second'));
    instance.clearBreadcrumbs();
    instance.captureException(new Error('third'));
    await instance.flush();
    const [first, second, third] = captured[0].events;
    expect(first.breadcrumbs).toMatchObject([{ category: 'manual', message: 'step one', data: { state: 'cart' } }]);
    expect(second.breadcrumbs?.map(crumb => crumb.message)).toEqual(['step one', 'step two']);
    expect(third.breadcrumbs).toBeUndefined();
    expect(first.breadcrumbs?.[0].occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(isBreadcrumbTrail(first.breadcrumbs)).toBe(true);
    expect(isBreadcrumbTrail(second.breadcrumbs)).toBe(true);
  });

  it('bounds a multibyte breadcrumb trail and sanitizes sensitive data', async () => {
    const instance = client();
    for (let index = 0; index < 24; index++) instance.addBreadcrumb({
      message: `step ${index} ${'한'.repeat(240)}`,
      data: { password: 'secret', path: '/checkout?token=hidden', email: 'bob@example.com' },
    });
    instance.captureException(new Error('bounded'));
    await instance.flush();
    const trail = captured[0].events[0].breadcrumbs;
    expect(trail?.length).toBeLessThan(BREADCRUMB_LIMITS.count);
    expect(trail?.at(-1)?.message).toContain('step 23');
    expect(new TextEncoder().encode(JSON.stringify(trail)).length).toBeLessThanOrEqual(BREADCRUMB_LIMITS.bytes);
    expect(isBreadcrumbTrail(trail)).toBe(true);
    expect(JSON.stringify(trail)).not.toMatch(/password|secret|token=hidden|bob@example.com/);
  });

  it('retains only the last 20 small breadcrumbs and isolates clients and automatic events', async () => {
    const first = client();
    const second = client();
    for (let index = 0; index < 24; index++) first.addBreadcrumb({ message: `step ${index}` });
    window.dispatchEvent(new ErrorEvent('error', { message: 'global failure' }));
    await first.flush();
    await second.flush();
    expect(captured[0].events[0].breadcrumbs?.map(crumb => crumb.message)).toEqual(
      Array.from({ length: 20 }, (_, index) => `step ${index + 4}`),
    );
    expect(captured[1].events[0].breadcrumbs).toBeUndefined();
    expect(isBreadcrumbTrail(captured[0].events[0].breadcrumbs)).toBe(true);
  });

  it('ignores invalid and hostile breadcrumb values and sanitizer failures without changing error stats', async () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('keys'); } });
    const instance = client({ sanitizeUrl: url => {
      if (url.includes('/private/')) throw new Error('unsafe URL');
      return url;
    } });
    expect(() => instance.addBreadcrumb({ message: 'GET /private/path?token=hidden' })).not.toThrow();
    instance.addBreadcrumb({ message: 'valid', data: { good: 2, nested: {}, invalid: Infinity } });
    instance.addBreadcrumb({ message: 'also valid', data: hostile });
    instance.addBreadcrumb({ message: ' ' });
    instance.captureException(new Error('failure'));
    await instance.flush();
    expect(captured[0].events[0].breadcrumbs?.map(crumb => crumb.message)).toEqual(['valid', 'also valid']);
    expect(captured[0].events[0].breadcrumbs?.[0].data).toEqual({ good: 2 });
    expect(instance.getStats()).toMatchObject({ sent: 1, dropped: 0 });
  });

  it('makes breadcrumb methods inert outside an active client', async () => {
    const disabled = client({ enabled: false });
    disabled.addBreadcrumb({ message: 'disabled' });
    disabled.clearBreadcrumbs();
    vi.stubGlobal('window', undefined);
    const server = client();
    server.addBreadcrumb({ message: 'server' });
    server.clearBreadcrumbs();
    vi.unstubAllGlobals();
    const active = client();
    active.addBreadcrumb({ message: 'before destroy' });
    active.destroy();
    active.addBreadcrumb({ message: 'after destroy' });
    active.clearBreadcrumbs();
    expect(disabled.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    expect(server.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
  });

  it('lets beforeSend remove or replace isolated breadcrumbs', async () => {
    const instance = client({ beforeSend: event => {
      if (event.message === 'remove') event.breadcrumbs = undefined;
      if (event.message === 'replace') event.breadcrumbs = [
        { occurredAt: new Date().toISOString(), category: 'custom', message: 'GET /private?token=hidden',
          data: { password: 'secret', valid: 'bob@example.com' } },
      ];
      if (event.message === 'mutate' && event.breadcrumbs) event.breadcrumbs[0].data!.state = 'changed';
      return event;
    } });
    instance.addBreadcrumb({ message: 'original', data: { state: 'initial' } });
    instance.captureException(new Error('remove'));
    instance.captureException(new Error('replace'));
    instance.captureException(new Error('mutate'));
    instance.captureException(new Error('later'));
    await instance.flush();
    const [removed, replaced, mutated, later] = captured[0].events;
    expect(removed.breadcrumbs).toBeUndefined();
    expect(replaced.breadcrumbs?.[0]).toMatchObject({ message: 'GET /private', data: { valid: '[REDACTED_EMAIL]' } });
    expect(mutated.breadcrumbs?.[0].data?.state).toBe('changed');
    expect(later.breadcrumbs?.[0].data?.state).toBe('initial');
    expect(isBreadcrumbTrail(replaced.breadcrumbs)).toBe(true);
    expect(JSON.stringify(captured)).not.toMatch(/token=hidden|bob@example.com|password|secret/);
  });

  it('drops an event once when beforeSend injects an unsanitizable breadcrumb', async () => {
    const instance = client({ sanitizeUrl: url => {
      if (url.includes('/private/')) throw new Error('unsafe URL');
      return url;
    }, beforeSend: event => {
      event.breadcrumbs = [{ occurredAt: new Date().toISOString(), category: 'manual',
        message: 'GET /private/path?token=hidden' }];
      return event;
    } });
    instance.captureException(new Error('failure'));
    await instance.flush();
    expect(instance.getStats()).toMatchObject({ sent: 0, dropped: 1 });
    expect(captured).toHaveLength(0);
  });

  it('inspects at most the last 20 replacement breadcrumb indices', async () => {
    const timestamp = new Date().toISOString();
    let numericReads = 0;
    const replacement = new Proxy([], { get(_target, key) {
      if (key === 'length') return 50_000;
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        numericReads++;
        if (key === '49998' || key === '49999') return { occurredAt: timestamp, category: 'manual', message: `step ${key}` };
      }
      return undefined;
    } }) as EventBatch['events'][number]['breadcrumbs'];
    const instance = client({ beforeSend: event => { event.breadcrumbs = replacement; return event; } });
    instance.captureException(new Error('bounded replacement'));
    await instance.flush();
    expect(numericReads).toBeLessThanOrEqual(BREADCRUMB_LIMITS.count);
    expect(captured[0].events[0].breadcrumbs?.map(crumb => crumb.message)).toEqual(['step 49998', 'step 49999']);
    expect(isBreadcrumbTrail(captured[0].events[0].breadcrumbs)).toBe(true);
  });

  it('drops a replacement trail with an invalid or throwing array length without dropping the event', async () => {
    let numericReads = 0;
    const invalid = [Infinity, 'throw'] as const;
    const instance = client({ beforeSend: event => {
      const behavior = invalid[event.sequence - 1];
      event.breadcrumbs = new Proxy([], { get(_target, key) {
        if (key === 'length') {
          if (behavior === 'throw') throw new Error('hostile length');
          return behavior;
        }
        if (typeof key === 'string' && /^\d+$/.test(key)) numericReads++;
        return undefined;
      } }) as EventBatch['events'][number]['breadcrumbs'];
      return event;
    } });
    instance.captureException(new Error('first'));
    instance.captureException(new Error('second'));
    await instance.flush();
    expect(numericReads).toBe(0);
    expect(captured[0].events.map(event => event.breadcrumbs)).toEqual([undefined, undefined]);
    expect(instance.getStats()).toMatchObject({ sent: 2, dropped: 0 });
  });
  it('keeps native console semantics and enriches the first Error argument', async () => {
    const receiver = { label: 'native receiver' };
    const first = new TypeError('first');
    const second = new Error('second');
    const args = ['prefix', first, second, 17];
    const native = vi.spyOn(console, 'error').mockImplementation(function (this: unknown, ...values: unknown[]) {
      expect(this).toBe(receiver);
      expect(values).toEqual(args);
      expect(values[1]).toBe(first);
      return 'native result' as unknown as void;
    });
    const instance = client({ captureConsole: true });
    expect(Reflect.apply(console.error, receiver, args)).toBe('native result');
    await instance.flush();
    expect(native).toHaveBeenCalledExactlyOnceWith(...args);
    expect(captured[0].events[0]).toMatchObject({
      type: 'console', message: args.map(String).join(' '), name: 'TypeError', stack: first.stack,
    });
    expect(captured[0].events[0].stack).not.toBe(second.stack);
  });

  it('does not invent console Error fields for primitive and plain object arguments, or lose hostile Proxy arguments', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const instance = client({ captureConsole: true });
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('hostile prototype'); } });
    console.error('plain', 17, { message: 'ordinary' }, hostile);
    await instance.flush();
    expect(captured[0].events).toHaveLength(1);
    expect(captured[0].events[0]).toMatchObject({ type: 'console', message: 'plain 17 [object Object] [object Object]' });
    expect(captured[0].events[0]).not.toHaveProperty('name');
    expect(captured[0].events[0]).not.toHaveProperty('stack');
  });

  it('preserves native console throws, opt-out, and teardown', async () => {
    const failure = new Error('native throw');
    const native = vi.spyOn(console, 'error').mockImplementation(() => { throw failure; });
    const original = console.error;
    const optedOut = client({ captureConsole: false });
    expect(console.error).toBe(original);
    const instance = client({ captureConsole: true });
    expect(() => console.error('throwing')).toThrow(failure);
    await instance.flush();
    expect(captured[0].events[0]).toMatchObject({ type: 'console', message: 'throwing' });
    instance.destroy();
    expect(console.error).toBe(original);
    expect(() => console.error('after teardown')).toThrow(failure);
    expect(native).toHaveBeenCalledTimes(2);
    optedOut.destroy();
  });

  it('sanitizes console Error stack URLs through hooks and honors beforeSend veto', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const urls: string[] = [];
    const instance = client({ captureConsole: true, sanitizeUrl: url => {
      urls.push(url);
      return url.replace('/private/', '/redacted/');
    }, beforeSend: event => event.message.includes('veto') ? false : event });
    const error = new Error('broken');
    error.stack = 'Error: broken\n at fn (https://user:pass@example.test/private/app.js?token=secret#part:12:3)';
    console.error('kept', error);
    console.error('veto', new Error('hidden'));
    await instance.flush();
    expect(captured[0].events).toHaveLength(1);
    expect(captured[0].events[0].stack).toContain('/redacted/app.js');
    expect(JSON.stringify(captured)).not.toMatch(/user:pass|token=secret|#part|hidden/);
    expect(urls.some(url => url.includes('/private/app.js'))).toBe(true);
  });

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

  it('reads genuine Request metadata with init precedence and keeps other fetch inputs safe', async () => {
    const response = new Response(null, { status: 503 });
    const native = vi.fn(function (this: unknown): Promise<Response> {
      expect(this).toBe(window);
      return Promise.resolve(response);
    });
    vi.stubGlobal('fetch', native);
    const instance = client({ captureNetwork: true, endpoint: '/collector' });
    const url = (path: string) => new URL(path, window.location.href);
    const request = new Request(url('/request?token=private'), { method: 'POST' });
    const override = { method: 'PUT' };
    const requestLike = { url: url('/decoy').href, method: 'POST', toString: () => '/stringified' };
    const hostile = { get url(): never { throw new Error('url getter'); }, get method(): never { throw new Error('method getter'); }, get signal(): never { throw new Error('signal getter'); }, toString: () => '/hostile' };

    expect(await window.fetch(request)).toBe(response);
    expect(await window.fetch(request, override)).toBe(response);
    expect(await window.fetch('/string?token=private')).toBe(response);
    expect(await window.fetch(url('/url?token=private'))).toBe(response);
    expect(await window.fetch(requestLike as unknown as Request)).toBe(response);
    expect(await window.fetch(hostile as unknown as Request, { get method(): never { throw new Error('init method'); }, get signal(): never { throw new Error('init signal'); } })).toBe(response);
    expect(await window.fetch(new Request(url('/collector'), { method: 'POST' }))).toBe(response);
    expect(native.mock.calls[1]).toEqual([request, override]);

    await instance.flush();
    expect(captured[0].events.map(event => event.network && [event.network.method, event.network.url])).toEqual([
      ['POST', url('/request').href],
      ['PUT', url('/request').href],
      ['GET', url('/string').href],
      ['GET', url('/url').href],
      ['GET', url('/stringified').href],
      ['GET', url('/hostile').href],
    ]);
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

  it('uses an explicit fetch signal override when classifying Request failures', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const active = new AbortController();
    const abortFailure = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const networkFailure = new TypeError('Failed to fetch');
    const request = new Request('https://example.test/offline', { signal: aborted.signal });
    const native = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.reject((init?.signal === undefined ? request.signal : init.signal)?.aborted ? abortFailure : networkFailure));
    vi.stubGlobal('fetch', native);
    const instance = client({ captureNetwork: true, endpoint: '/collector' });

    await expect(window.fetch(request)).rejects.toBe(abortFailure);
    await expect(window.fetch(request, { signal: undefined })).rejects.toBe(abortFailure);
    await expect(window.fetch(request, { signal: null })).rejects.toBe(networkFailure);
    await expect(window.fetch(request, { signal: active.signal })).rejects.toBe(networkFailure);
    await expect(window.fetch(request, { signal: aborted.signal })).rejects.toBe(abortFailure);
    await instance.flush();

    expect(native).toHaveBeenCalledTimes(5);
    expect(captured[0].events.map(event => event.network?.url)).toEqual([
      'https://example.test/offline',
      'https://example.test/offline',
    ]);
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

  it('discards an active XHR request on successful reopen but retains it after failed operations', async () => {
    class FakeXHR extends EventTarget {
      status = 503;
      active = false;
      open(_method: string, url: string): void {
        if (url === '/invalid') throw new Error('invalid URL');
        this.active = false;
      }
      send(): void {
        if (this.active) throw new Error('already sent');
        this.active = true;
      }
      finish(): void {
        this.active = false;
        this.dispatchEvent(new Event('loadend'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const instance = client({ captureNetwork: true, endpoint: '/collector', shouldCaptureHttp: () => true });
    const xhr = new XMLHttpRequest() as XMLHttpRequest & FakeXHR;

    xhr.open('GET', '/old');
    xhr.send();
    xhr.open('GET', '/new');
    xhr.send();
    xhr.finish();
    xhr.open('GET', '/kept');
    xhr.send();
    expect(() => xhr.open('GET', '/invalid')).toThrow('invalid URL');
    expect(() => xhr.send()).toThrow('already sent');
    xhr.finish();

    await instance.flush();
    expect(captured[0].events.map(event => event.network?.url)).toEqual([
      new URL('/new', window.location.href).href,
      new URL('/kept', window.location.href).href,
    ]);
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

  it('keeps native error location with a sanitized filename', async () => {
    const instance = client();
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'primitive failure', filename: 'https://user:pass@example.test/app.js?token=private#part',
      lineno: 12, colno: 7,
    }));
    await instance.flush();
    expect(captured[0].events[0]).toMatchObject({
      type: 'javascript', message: 'primitive failure',
      context: { filename: 'https://example.test/app.js', lineno: 12, colno: 7 },
    });
    expect(JSON.stringify(captured)).not.toMatch(/user:pass|token=private|#part/);
  });

  it('adds shared context to manual, React, global, promise, HTTP, network, and console events', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('offline')
      ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(null, { status: 503 }))));
    const instance = client({ context: { team: 'checkout', attempt: 2 }, captureConsole: true,
      captureNetwork: true, endpoint: '/collector' });
    instance.captureException(new Error('manual'));
    instance.captureException(new Error('react'), { type: 'react' });
    window.dispatchEvent(new ErrorEvent('error', { message: 'global' }));
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new Error('promise') });
    window.dispatchEvent(rejection);
    await window.fetch('/failed');
    await expect(window.fetch('/offline')).rejects.toThrow('offline');
    console.error('console');
    await instance.flush();
    expect(captured[0].events.map(event => event.type)).toEqual([
      'manual', 'react', 'javascript', 'promise', 'http', 'network', 'console',
    ]);
    expect(captured[0].events.every(event => event.context?.team === 'checkout' && event.context?.attempt === 2)).toBe(true);
  });

  it('keeps event context first and within 12 fields, including native source location', async () => {
    const defaults = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`default${index}`, index]));
    const instance = client({ context: { ...defaults, filename: 'wrong', shared: 'default' } });
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'global', filename: '/actual.js?token=secret', lineno: 12, colno: 7,
    }));
    instance.captureException(new Error('manual'), { context: { shared: 'event', own: true } });
    await instance.flush();
    const [global, manual] = captured[0].events;
    expect(global.context).toMatchObject({ filename: `${window.location.origin}/actual.js`, lineno: 12, colno: 7 });
    expect(Object.keys(global.context ?? {})).toHaveLength(12);
    expect(global.context).not.toHaveProperty('default9');
    expect(manual.context).toMatchObject({ shared: 'event', own: true, default0: 0 });
    expect(Object.keys(manual.context ?? {})).toHaveLength(12);
  });

  it('snapshots dynamic context once per event with event and init context priority', async () => {
    let state = 'first';
    const getContext = vi.fn(() => ({ state, tier: 'dynamic', password: 'secret', request: '/api?token=hidden' }));
    const defaults = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`default${index}`, index]));
    const instance = client({ context: { ...defaults, tier: 'init' }, getContext });
    instance.captureException(new Error('one'), { context: { tier: 'event', own: true } });
    state = 'second';
    instance.captureException(new Error('two'));
    await instance.flush();
    expect(getContext).toHaveBeenCalledTimes(2);
    const [first, second] = captured[0].events;
    expect(first.context).toMatchObject({ tier: 'event', own: true, state: 'first', request: '/api', default0: 0 });
    expect(second.context).toMatchObject({ tier: 'dynamic', state: 'second', request: '/api', default0: 0 });
    expect(Object.keys(first.context ?? {})).toHaveLength(12);
    expect(Object.keys(second.context ?? {})).toHaveLength(12);
    expect(JSON.stringify(captured)).not.toMatch(/secret|token=hidden/);
  });

  it('drops a throwing dynamic resolver once and recovers for manual and automatic paths', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('offline')
      ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(null, { status: 503 }))));
    let throws = true;
    const getContext = vi.fn(() => {
      if (throws) throw new Error('resolver failed');
      return { recovered: true };
    });
    const instance = client({ getContext, captureNetwork: true, endpoint: '/collector', captureConsole: true });
    const error = new Error('manual');
    expect(() => instance.captureException(error)).not.toThrow();
    expect(() => window.dispatchEvent(new ErrorEvent('error', { message: 'global' }))).not.toThrow();
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new Error('promise') });
    expect(() => window.dispatchEvent(rejection)).not.toThrow();
    await window.fetch('/failed');
    await expect(window.fetch('/offline')).rejects.toThrow('offline');
    expect(() => console.error('console')).not.toThrow();
    expect(instance.getStats()).toMatchObject({ queued: 0, dropped: 6 });
    throws = false;
    instance.captureException(error);
    await window.fetch('/recovered');
    await instance.flush();
    expect(getContext).toHaveBeenCalledTimes(8);
    expect(captured[0].events.map(event => event.context)).toEqual([{ recovered: true }, { recovered: true }]);
    expect(instance.getStats()).toMatchObject({ sent: 2, dropped: 6 });
  });

  it('preserves native source fields ahead of dynamic context and honors beforeSend removal', async () => {
    const dynamic = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`dynamic${index}`, index]));
    const instance = client({
      context: { initOnly: true },
      getContext: () => ({ filename: 'wrong', ...dynamic, password: 'secret' }),
      beforeSend: event => {
        if (event.message === 'remove') event.context = undefined;
        return event;
      },
    });
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'keep', filename: '/actual.js?token=hidden', lineno: 4, colno: 9,
    }));
    instance.captureException(new Error('remove'));
    await instance.flush();
    const [kept, removed] = captured[0].events;
    expect(kept.context).toMatchObject({ filename: `${window.location.origin}/actual.js`, lineno: 4, colno: 9, dynamic0: 0 });
    expect(Object.keys(kept.context ?? {})).toHaveLength(12);
    expect(kept.context).not.toHaveProperty('initOnly');
    expect(removed.context).toBeUndefined();
    expect(JSON.stringify(captured)).not.toMatch(/secret|token=hidden/);
  });

  it('does not resolve dynamic context for disabled, server, destroyed, or deduped captures', async () => {
    const getContext = vi.fn(() => ({ state: 'live' }));
    const disabled = client({ enabled: false, getContext });
    disabled.captureException(new Error('disabled'));
    vi.stubGlobal('window', undefined);
    const server = client({ getContext });
    server.captureException(new Error('server'));
    vi.unstubAllGlobals();
    const active = client({ getContext });
    const error = new Error('once');
    active.captureException(error);
    active.captureException(error);
    await active.flush();
    active.destroy();
    active.captureException(new Error('destroyed'));
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('captures shared context when Object.hasOwn is unavailable', async () => {
    const instance = client({ context: { team: 'default', attempt: 2 } });
    const original = Object.getOwnPropertyDescriptor(Object, 'hasOwn');
    try {
      Object.defineProperty(Object, 'hasOwn', { ...original, value: undefined });
      instance.captureException(new Error('fallback'), { context: { team: 'event' } });
    } finally {
      if (original) Object.defineProperty(Object, 'hasOwn', original);
      else Reflect.deleteProperty(Object, 'hasOwn');
    }
    await instance.flush();
    expect(captured[0].events[0].context).toEqual({ team: 'event', attempt: 2 });
  });

  it('sanitizes shared context and lets beforeSend remove it without affecting another client', async () => {
    const shared = { password: 'secret', team: 'bob@example.com', request: '/api?token=secret', nested: { unsafe: true }, count: 3 };
    const first = client({ context: shared, beforeSend: event => { event.context = undefined; return event; } });
    const second = client({ context: shared });
    first.captureException(new Error('first'));
    second.captureException(new Error('second'));
    await first.flush();
    await second.flush();
    expect(captured[0].events[0].context).toBeUndefined();
    expect(captured[1].events[0].context).toEqual({ team: '[REDACTED_EMAIL]', request: '/api', count: 3 });
    expect(shared).toEqual({ password: 'secret', team: 'bob@example.com', request: '/api?token=secret', nested: { unsafe: true }, count: 3 });
    expect(JSON.stringify(captured)).not.toContain('token=secret');
  });

  it('ignores hostile and unsupported shared context values without changing later events', async () => {
    const throwing: Record<string, unknown> = { valid: 'kept', invalid: Infinity, nested: { secret: true } };
    Object.defineProperty(throwing, 'bad', { enumerable: true, get: () => { throw new Error('getter'); } });
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('keys'); } });
    const first = client({ context: throwing });
    const second = client({ context: hostile });
    first.captureException(new Error('first'));
    second.captureException(new Error('second'));
    first.captureException(new Error('third'));
    await first.flush();
    await second.flush();
    expect(captured[0].events.map(event => event.context)).toEqual([{ valid: 'kept' }, { valid: 'kept' }]);
    expect(captured[1].events[0].context).toBeUndefined();
  });

  it('runs the URL hook for relative and absolute native filenames', async () => {
    const paths: string[] = [];
    const instance = client({ sanitizeUrl: url => {
      paths.push(url);
      return new URL(url, window.location.href).pathname.replace('/private/', '/redacted/');
    } });
    window.dispatchEvent(new ErrorEvent('error', { message: 'relative', filename: '/private/a.js?token=one', lineno: 2 }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'absolute', filename: 'https://user:pass@example.test/private/b.js?token=two', colno: 3 }));
    await instance.flush();
    const [relative, absolute] = captured[0].events;
    expect(paths).toContain('/private/a.js?token=one');
    expect(paths).toContain('https://user:pass@example.test/private/b.js?token=two');
    expect(relative.context).toMatchObject({ filename: `${window.location.origin}/redacted/a.js`, lineno: 2 });
    expect(absolute.context).toMatchObject({ filename: `${window.location.origin}/redacted/b.js`, colno: 3 });
    expect(JSON.stringify(captured)).not.toMatch(/private\/|token=one|token=two|user:pass/);
  });

  it('omits absent or invalid native source fields and tolerates a throwing getter', async () => {
    const instance = client();
    window.dispatchEvent(new ErrorEvent('error', { message: 'no source' }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'invalid source', filename: ' ', lineno: 0, colno: 0 }));
    const nonFinite = new Event('error');
    Object.defineProperties(nonFinite, {
      message: { value: 'nonfinite source' }, lineno: { value: Infinity }, colno: { value: NaN },
    });
    window.dispatchEvent(nonFinite);
    const hostile = new Event('error');
    Object.defineProperty(hostile, 'filename', { get: () => { throw new Error('hostile filename'); } });
    Object.defineProperty(hostile, 'message', { value: 'getter failure' });
    window.dispatchEvent(hostile);
    await instance.flush();
    expect(captured[0].events.map(event => event.message)).toEqual(['no source', 'invalid source', 'nonfinite source', 'getter failure']);
    expect(captured[0].events.every(event => event.context === undefined)).toBe(true);
  });

  it('drops a native error if its filename sanitizer throws and still honors beforeSend', async () => {
    const failing = client({ sanitizeUrl: url => {
      if (url.includes('/private/')) throw new Error('unsafe path');
      return url;
    } });
    expect(() => window.dispatchEvent(new ErrorEvent('error', { message: 'secret', filename: '/private/a.js' }))).not.toThrow();
    await failing.flush();
    expect(failing.getStats()).toMatchObject({ sent: 0, dropped: 1 });
    failing.destroy();
    const vetoed = client({ beforeSend: () => false });
    window.dispatchEvent(new ErrorEvent('error', { message: 'veto', filename: '/safe.js', lineno: 4 }));
    await vetoed.flush();
    expect(vetoed.getStats()).toMatchObject({ sent: 0, queued: 0 });
    expect(captured).toHaveLength(0);
    vetoed.destroy();

    let seen: unknown;
    const altered = client({ beforeSend: event => {
      seen = event.context;
      event.context = undefined;
      return event;
    } });
    window.dispatchEvent(new ErrorEvent('error', { message: 'removed source', filename: '/safe.js', lineno: 5 }));
    await altered.flush();
    expect(seen).toMatchObject({ filename: `${window.location.origin}/safe.js`, lineno: 5 });
    expect(captured[0].events[0].context).toBeUndefined();
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

  it.each([
    ['Request /api/users?token=private failed', 'Request /api/users failed'],
    ['Request api/users?token=private failed', 'Request api/users failed'],
    ['GET users?token=private, then retry', 'GET users, then retry'],
    ['GET ?token=private failed', 'GET [redacted query] failed'],
    ['GET [/api/users?token=private], then retry', 'GET [/api/users], then retry'],
    ['GET /reset#token=private. Retry', 'GET /reset. Retry'],
    ['ratio 1/2?maybe and ratio1/2?maybe', 'ratio 1/2?maybe and ratio1/2?maybe'],
  ])('sanitizes relative URL text: %s', async (message, expected) => {
    const instance = client();
    instance.captureException(new Error(message), {
      context: { request: '/api/users?api_key=hidden' },
    });
    await instance.flush();
    const event = captured[0].events[0];
    expect(JSON.stringify(event)).not.toMatch(/token=private|api_key=hidden/);
    expect(event.message).toBe(expected);
    expect(event.context?.request).toBe('/api/users');
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

  it('counts only beacon candidates accepted on hidden visibility changes', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const instance = client({ transport: undefined, endpoint: '/collect', maxQueueSize: 20 });
    for (let index = 0; index < 12; index++) instance.captureException(`failure ${index}`);

    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 2, sent: 10, dropped: 0 });

    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(2);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 12, dropped: 0 });

    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(2);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 12, dropped: 0 });
  });

  it.each(['false', 'throw'] as const)('keeps beacon candidates when sendBeacon returns %s, then flushes normally', async outcome => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const sendBeacon = vi.fn(() => {
      if (outcome === 'throw') throw new Error('beacon unavailable');
      return false;
    });
    vi.stubGlobal('navigator', { sendBeacon });
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetch);
    const instance = client({ transport: undefined, endpoint: '/collect' });
    instance.captureException('retry later');

    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 1, sent: 0, dropped: 0 });

    await instance.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
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
