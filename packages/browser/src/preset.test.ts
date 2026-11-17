import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogCaptureClient, type BrowserErrorLogOptions } from './index';

const clients: BrowserErrorLogCaptureClient[] = [];

function client(options: Partial<BrowserErrorLogOptions> = {}) {
  const batches: EventBatch[] = [];
  const instance = init({ project: 'preset-test', endpoint: '/collector',
    transport: batch => { batches.push(JSON.parse(JSON.stringify(batch)) as EventBatch); }, ...options });
  clients.push(instance);
  return { instance, events: () => batches.flatMap(batch => batch.events) };
}

afterEach(() => {
  clients.splice(0).forEach(instance => instance.destroy());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('capture presets', () => {
  it('minimal installs no automatic capture instrumentation, but delivers manual events on its normal timer without stacks', async () => {
    vi.useFakeTimers();
    const nativeFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal('fetch', nativeFetch);
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    const nativeConsole = console.error;
    const nativePush = window.history.pushState;
    const nativeReplace = window.history.replaceState;
    const listeners = vi.spyOn(window, 'addEventListener');
    const stackRead = vi.fn(() => 'private trace');
    const causeRead = vi.fn(() => new Error('private cause'));
    const error = { message: 'manual failure', name: 'ControlledError', get stack() { return stackRead(); }, get cause() { return causeRead(); } };
    const { instance, events } = client({ preset: 'minimal', flushIntervalMs: 10,
      beforeSend: event => ({ ...event, stack: 'injected stack', componentStack: 'injected component' }) });
    expect(window.fetch).toBe(nativeFetch);
    expect(XMLHttpRequest.prototype.open).toBe(nativeOpen);
    expect(XMLHttpRequest.prototype.send).toBe(nativeSend);
    expect(console.error).toBe(nativeConsole);
    expect(window.history.pushState).toBe(nativePush);
    expect(window.history.replaceState).toBe(nativeReplace);
    expect(listeners.mock.calls.filter(([type]) => ['error', 'unhandledrejection', 'popstate', 'hashchange'].includes(String(type)))).toEqual([]);
    instance.addBreadcrumb({ message: 'Clicked retry' });
    const id = instance.captureException(error, { componentStack: 'React stack', context: { action: 'retry' } });
    expect(typeof id).toBe('string');
    expect(instance.getStats().queued).toBe(1);
    await vi.advanceTimersByTimeAsync(11);
    expect(instance.getStats()).toMatchObject({ queued: 0, sent: 1 });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ eventId: id, message: 'manual failure', name: 'ControlledError', context: { action: 'retry' },
      breadcrumbs: [{ category: 'manual', message: 'Clicked retry' }] });
    expect(Object.hasOwn(events()[0], 'stack')).toBe(false);
    expect(Object.hasOwn(events()[0], 'componentStack')).toBe(false);
    expect(stackRead).not.toHaveBeenCalled();
    expect(causeRead).not.toHaveBeenCalled();
  });

  it('omitted and explicit standard preserve existing automatic defaults and stack capture', async () => {
    const nativeFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal('fetch', nativeFetch);
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    const nativeConsole = console.error;
    const nativePush = window.history.pushState;
    const listeners = vi.spyOn(window, 'addEventListener');
    const omitted = client();
    const explicit = client({ preset: 'standard' });
    expect(window.fetch).not.toBe(nativeFetch);
    expect(XMLHttpRequest.prototype.open).not.toBe(nativeOpen);
    expect(XMLHttpRequest.prototype.send).not.toBe(nativeSend);
    expect(console.error).toBe(nativeConsole);
    expect(window.history.pushState).toBe(nativePush);
    expect(listeners.mock.calls.filter(([type, , capture]) => type === 'error' && capture !== true)).toHaveLength(2);
    expect(listeners.mock.calls.filter(([type]) => type === 'unhandledrejection')).toHaveLength(2);
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('global standard') }));
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new Error('promise standard') });
    window.dispatchEvent(rejection);
    const error = new Error('manual standard');
    omitted.instance.captureException(error);
    explicit.instance.captureException(new Error('manual standard explicit'));
    await Promise.all([omitted.instance.flush(), explicit.instance.flush()]);
    expect(omitted.events().map(event => event.type)).toEqual(['javascript', 'promise', 'manual']);
    expect(explicit.events().map(event => event.type)).toEqual(['javascript', 'promise', 'manual']);
    expect(omitted.events()[2].stack).toContain('manual standard');
    expect(explicit.events()[2].stack).toContain('manual standard explicit');
  });

  it('detailed enables diagnostic hooks, breadcrumbs and Error.cause within existing limits', async () => {
    const nativeFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal('fetch', nativeFetch);
    const nativePush = window.history.pushState;
    const nativeConsole = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listeners = vi.spyOn(window, 'addEventListener');
    const { instance, events } = client({ preset: 'detailed' });
    expect(window.fetch).not.toBe(nativeFetch);
    expect(window.history.pushState).not.toBe(nativePush);
    expect(console.error).not.toBe(nativeConsole);
    expect(listeners.mock.calls.some(([type, , capture]) => type === 'error' && capture === true)).toBe(true);
    expect(listeners.mock.calls.some(([type]) => type === 'unhandledrejection')).toBe(true);
    window.history.pushState(null, '', '/detail');
    await window.fetch('/failed');
    console.error('controlled console');
    instance.captureException(new Error('outer', { cause: new Error('inner') }), { componentStack: 'at ControlledView' });
    await instance.flush();
    expect(events().map(event => event.type)).toEqual(['http', 'console', 'manual']);
    expect(events().at(-1)?.stack).toContain('Caused by: Error: inner');
    expect(events().at(-1)?.componentStack).toBe('at ControlledView');
    expect(events().at(-1)?.breadcrumbs?.map(crumb => crumb.category)).toEqual(['navigation', 'http']);
  });

  it('explicit booleans override presets, undefined inherits them, and clients snapshot separate choices', async () => {
    const nativeFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal('fetch', nativeFetch);
    const firstBatches: EventBatch[] = [];
    const options: BrowserErrorLogOptions = { project: 'minimal-client', endpoint: '/collector', preset: 'minimal',
      captureGlobalErrors: true, captureNetwork: undefined, captureConsole: undefined, captureStack: true,
      transport: batch => { firstBatches.push(batch); } };
    const first = init(options);
    clients.push(first);
    expect(window.fetch).toBe(nativeFetch);
    const other = client({ preset: 'detailed', captureGlobalErrors: false, captureNetwork: false,
      captureNetworkBreadcrumbs: false, captureConsole: false, captureStack: false });
    options.preset = 'detailed';
    options.captureGlobalErrors = false;
    options.captureStack = false;
    const error = new Error('global fixture');
    window.dispatchEvent(new ErrorEvent('error', { error }));
    expect(first.getStats().queued).toBe(1);
    expect(other.instance.getStats().queued).toBe(0);
    const firstId = first.captureException(new Error('manual first'));
    const secondId = other.instance.captureException(new Error('manual second'));
    expect(typeof firstId).toBe('string');
    expect(typeof secondId).toBe('string');
    expect(window.fetch).toBe(nativeFetch);
    expect(options.preset).toBe('detailed');
    await Promise.all([first.flush(), other.instance.flush()]);
    expect(firstBatches.flatMap(batch => batch.events).map(event => event.type)).toEqual(['javascript', 'manual']);
    expect(firstBatches.flatMap(batch => batch.events)[1].stack).toContain('manual first');
    expect(other.events()[0].stack).toBeUndefined();
  });

  it('enabled false remains the master off switch even with detailed selected', async () => {
    const nativeFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal('fetch', nativeFetch);
    const nativeConsole = console.error;
    const nativePush = window.history.pushState;
    const listeners = vi.spyOn(window, 'addEventListener');
    const disabled = client({ enabled: false, preset: 'detailed' });
    expect(window.fetch).toBe(nativeFetch);
    expect(console.error).toBe(nativeConsole);
    expect(window.history.pushState).toBe(nativePush);
    expect(listeners.mock.calls).toHaveLength(0);
    expect(disabled.instance.captureException(new Error('suppressed'))).toBeUndefined();
    await disabled.instance.flush();
    expect(disabled.events()).toEqual([]);
  });

  it('captureStack false skips stack and cause getters even when cause capture is enabled', async () => {
    const stackRead = vi.fn(() => 'private stack');
    const causeRead = vi.fn(() => new Error('private cause'));
    const injectedStackRead = vi.fn(() => 'injected stack');
    const injectedComponentRead = vi.fn(() => 'injected component');
    const error = { message: 'safe message', name: 'SafeError',
      get stack() { return stackRead(); }, get cause() { return causeRead(); } };
    const { instance, events } = client({ preset: 'detailed', captureStack: false, captureErrorCause: true,
      beforeSend(event) {
        Object.defineProperty(event, 'stack', { get: injectedStackRead });
        Object.defineProperty(event, 'componentStack', { get: injectedComponentRead });
        return event;
      } });
    instance.captureException(error, { componentStack: 'React stack' });
    await instance.flush();
    expect(events()[0]).toMatchObject({ message: 'safe message', name: 'SafeError' });
    expect(Object.hasOwn(events()[0], 'stack')).toBe(false);
    expect(Object.hasOwn(events()[0], 'componentStack')).toBe(false);
    expect(stackRead).not.toHaveBeenCalled();
    expect(causeRead).not.toHaveBeenCalled();
    expect(injectedStackRead).not.toHaveBeenCalled();
    expect(injectedComponentRead).not.toHaveBeenCalled();
  });

  it('destroy restores instrumentation so a later init can select a different preset', async () => {
    const nativeFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal('fetch', nativeFetch);
    const nativeConsole = console.error;
    const minimal = client({ preset: 'minimal' });
    expect(window.fetch).toBe(nativeFetch);
    expect(console.error).toBe(nativeConsole);
    minimal.instance.destroy();
    const detailed = client({ preset: 'detailed' });
    expect(window.fetch).not.toBe(nativeFetch);
    expect(console.error).not.toBe(nativeConsole);
    detailed.instance.destroy();
    expect(window.fetch).toBe(nativeFetch);
    expect(console.error).toBe(nativeConsole);
  });

  it('only boolean overrides count, retaining standard defaults for malformed JavaScript values', async () => {
    const nativeFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal('fetch', nativeFetch);
    const nativeConsole = console.error;
    const nativePush = window.history.pushState;
    const { instance, events } = client({ captureNetwork: 'false' as unknown as boolean,
      captureConsole: 'false' as unknown as boolean,
      captureNavigation: 0 as unknown as boolean,
      captureResourceErrors: 'false' as unknown as boolean,
      captureNetworkBreadcrumbs: 'false' as unknown as boolean,
      captureErrorCause: 'false' as unknown as boolean });
    expect(window.fetch).not.toBe(nativeFetch);
    expect(console.error).toBe(nativeConsole);
    expect(window.history.pushState).toBe(nativePush);
    await window.fetch('/successful');
    instance.captureException(new Error('outer', { cause: new Error('inner') }));
    await instance.flush();
    expect(events()).toHaveLength(1);
    expect(events()[0].breadcrumbs).toBeUndefined();
    expect(events()[0].stack).not.toContain('Caused by:');
  });

  it('does not turn on minimal hooks for malformed JavaScript values', () => {
    const nativeFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal('fetch', nativeFetch);
    const nativeConsole = console.error;
    const nativePush = window.history.pushState;
    const listeners = vi.spyOn(window, 'addEventListener');
    const { instance } = client({ preset: 'minimal',
      captureGlobalErrors: 'false' as unknown as boolean,
      captureUnhandledRejections: 0 as unknown as boolean,
      captureNetwork: 'false' as unknown as boolean,
      captureConsole: 'false' as unknown as boolean,
      captureResourceErrors: 0 as unknown as boolean,
      captureNavigation: 'false' as unknown as boolean,
      captureNetworkBreadcrumbs: 0 as unknown as boolean,
      captureStack: 'false' as unknown as boolean });
    expect(window.fetch).toBe(nativeFetch);
    expect(console.error).toBe(nativeConsole);
    expect(window.history.pushState).toBe(nativePush);
    expect(listeners.mock.calls.filter(([type]) => ['error', 'unhandledrejection', 'popstate', 'hashchange'].includes(String(type)))).toEqual([]);
    expect(instance.captureException(new Error('manual'))).toBeDefined();
  });
});
