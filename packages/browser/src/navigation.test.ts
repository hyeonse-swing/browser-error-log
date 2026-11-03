import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BREADCRUMB_LIMITS, isBreadcrumbTrail, type EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogOptions, type BrowserErrorLogBreadcrumbClient } from './index';

const clients: BrowserErrorLogBreadcrumbClient[] = [];
let initialHref: string;
let initialPush: PropertyDescriptor | undefined;
let initialReplace: PropertyDescriptor | undefined;

function client(overrides: Partial<BrowserErrorLogOptions> = {}) {
  const batches: EventBatch[] = [];
  const instance = init({ project: 'navigation-test', transport: batch => { batches.push(batch); },
    captureNetwork: false, ...overrides });
  clients.push(instance);
  return { instance, batches };
}

function trail(batches: EventBatch[]) {
  return batches[0].events[0].breadcrumbs;
}

beforeEach(() => {
  initialHref = window.location.href;
  initialPush = Object.getOwnPropertyDescriptor(window.history, 'pushState');
  initialReplace = Object.getOwnPropertyDescriptor(window.history, 'replaceState');
  window.history.replaceState(null, '', '/start?token=before#part');
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const instance of clients.splice(0)) instance.destroy();
  if (initialPush) Object.defineProperty(window.history, 'pushState', initialPush);
  else Reflect.deleteProperty(window.history, 'pushState');
  if (initialReplace) Object.defineProperty(window.history, 'replaceState', initialReplace);
  else Reflect.deleteProperty(window.history, 'replaceState');
  window.history.replaceState(null, '', initialHref);
  vi.restoreAllMocks();
});

describe('opt-in navigation breadcrumbs', () => {
  it('records successful pushState and replaceState without queuing navigation events', async () => {
    const { instance, batches } = client({ captureNavigation: true });
    const nativePush = History.prototype.pushState;
    const original = Object.getOwnPropertyDescriptor(window.history, 'pushState');
    expect(original?.value).not.toBe(nativePush);
    const state = { secret: 'never copied' };
    const args: Parameters<History['pushState']> = [state, 'private title', '/one?token=hidden#frag'];
    const receiver = window.history;
    expect(Reflect.apply(window.history.pushState, receiver, args)).toBeUndefined();
    expect(window.history.state).toBe(state);
    window.history.replaceState({ password: 'other' }, 'another private title', '/two?session=hidden#section');
    expect(instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    instance.captureException(new Error('failure'));
    await instance.flush();
    expect(batches[0].events).toHaveLength(1);
    expect(trail(batches)).toMatchObject([
      { category: 'navigation', message: 'Navigation', data: {
        from: 'http://localhost:3000/start', to: 'http://localhost:3000/one', trigger: 'pushState',
      } },
      { category: 'navigation', message: 'Navigation', data: {
        from: 'http://localhost:3000/one', to: 'http://localhost:3000/two', trigger: 'replaceState',
      } },
    ]);
    expect(isBreadcrumbTrail(trail(batches))).toBe(true);
    expect(JSON.stringify(batches)).not.toMatch(/token=|session=|#frag|#section|never copied|private title|password/);
  });

  it('preserves native receiver, arguments, return value, and native failures', async () => {
    const native = window.history.pushState;
    const nativeReplace = window.history.replaceState;
    const returnValue = Symbol('native return');
    const nativeError = new Error('native failed');
    const calls: Array<{ receiver: unknown; args: unknown[] }> = [];
    const original = function (this: History, ...args: Parameters<History['pushState']>) {
      calls.push({ receiver: this, args });
      Reflect.apply(native, this, args);
      return returnValue as unknown as void;
    };
    Object.defineProperty(window.history, 'pushState', { configurable: true, enumerable: true,
      writable: true, value: original });
    Object.defineProperty(window.history, 'replaceState', { configurable: true, writable: true,
      value: function (this: History, ...args: Parameters<History['replaceState']>) {
        if (args[2] === '/failed') throw nativeError;
        return Reflect.apply(nativeReplace, this, args);
      } });
    const { instance, batches } = client({ captureNavigation: true });
    const args: Parameters<History['pushState']> = [{ nested: { secret: 'payload' } }, 'title', '/one'];
    expect(Reflect.apply(window.history.pushState, window.history, args)).toBe(returnValue);
    expect(calls[0].receiver).toBe(window.history);
    expect(calls[0].args[0]).toBe(args[0]);
    expect(calls[0].args[1]).toBe(args[1]);
    expect(calls[0].args[2]).toBe(args[2]);
    expect(() => Reflect.apply(window.history.pushState, {}, args)).toThrow();
    let caught: unknown;
    try { window.history.replaceState(null, '', '/failed'); } catch (error) { caught = error; }
    expect(caught).toBe(nativeError);
    instance.captureException(new Error('after navigation'));
    await instance.flush();
    expect(trail(batches)?.map(crumb => crumb.data?.trigger)).toEqual(['pushState']);
  });

  it('does not record default-off, state-only, query-only, hash-only, or failed native calls', async () => {
    const previousPush = window.history.pushState;
    const off = client();
    expect(window.history.pushState).toBe(previousPush);
    window.history.pushState(null, '', '/start?token=off#part');
    off.instance.captureException(new Error('off'));
    await off.instance.flush();
    expect(trail(off.batches)).toBeUndefined();

    const { instance, batches } = client({ captureNavigation: true });
    window.history.pushState({ step: 1 }, 'state only');
    window.history.pushState(null, '', '/start?token=changed#part');
    window.history.replaceState(null, '', '/start?token=changed#other');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(() => window.history.pushState(null, '', 'https://other.example/path')).toThrow();
    expect(instance.getStats().queued).toBe(0);
    instance.captureException(new Error('none'));
    await instance.flush();
    expect(trail(batches)).toBeUndefined();
  });

  it('records a popstate traversal once when hashchange follows the same raw URL', async () => {
    const { instance, batches } = client({ captureNavigation: true });
    window.history.pushState(null, '', '/next');
    const nativeReplace = History.prototype.replaceState;
    Reflect.apply(nativeReplace, window.history, [null, '', '/back?token=hidden#hash']);
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    instance.captureException(new Error('back failure'));
    await instance.flush();
    expect(trail(batches)?.map(crumb => crumb.data?.trigger)).toEqual(['pushState', 'popstate']);
    expect(trail(batches)?.[1].data).toMatchObject({
      from: 'http://localhost:3000/next', to: 'http://localhost:3000/back', trigger: 'popstate',
    });
  });

  it('fans out only to opted-in active clients and restores the inherited method after the last destroy', async () => {
    const off = client({ captureNavigation: false });
    const firstOptions: BrowserErrorLogOptions = { project: 'first', transport: batch => { first.batches.push(batch); },
      captureNetwork: false, captureNavigation: true };
    const first = { batches: [] as EventBatch[], instance: undefined as unknown as BrowserErrorLogBreadcrumbClient };
    first.instance = init(firstOptions);
    clients.push(first.instance);
    const wrapped = window.history.pushState;
    const second = client({ captureNavigation: true });
    expect(window.history.pushState).toBe(wrapped);
    window.history.pushState(null, '', '/one');
    first.instance.captureException(new Error('first'));
    second.instance.captureException(new Error('second'));
    off.instance.captureException(new Error('off'));
    await Promise.all([first.instance.flush(), second.instance.flush(), off.instance.flush()]);
    expect(trail(first.batches)).toHaveLength(1);
    expect(trail(second.batches)).toHaveLength(1);
    expect(trail(off.batches)).toBeUndefined();
    firstOptions.captureNavigation = false;
    first.instance.destroy();
    expect(window.history.pushState).toBe(wrapped);
    window.history.pushState(null, '', '/two');
    second.instance.captureException(new Error('still active'));
    await second.instance.flush();
    expect(second.batches[1].events[0].breadcrumbs).toHaveLength(2);
    second.instance.destroy();
    expect(Object.getOwnPropertyDescriptor(window.history, 'pushState')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(window.history, 'replaceState')).toBeUndefined();
  });

  it('keeps later host wrappers and restores an original own descriptor exactly', () => {
    const native = window.history.pushState;
    const descriptor: PropertyDescriptor = { configurable: true, enumerable: true,
      writable: false, value: function (this: History, ...args: Parameters<History['pushState']>) {
        return Reflect.apply(native, this, args);
      } };
    Object.defineProperty(window.history, 'pushState', descriptor);
    const { instance } = client({ captureNavigation: true });
    const sdkWrapper = window.history.pushState;
    const foreign = function (this: History, ...args: Parameters<History['pushState']>) {
      return Reflect.apply(sdkWrapper, this, args);
    };
    expect(Object.getOwnPropertyDescriptor(window.history, 'pushState')?.writable).toBe(false);
    expect(Reflect.set(window.history, 'pushState', foreign)).toBe(false);
    expect(window.history.pushState).toBe(sdkWrapper);
    Object.defineProperty(window.history, 'pushState', { configurable: true, writable: true, value: foreign });
    instance.destroy();
    expect(window.history.pushState).toBe(foreign);
    window.history.pushState(null, '', '/foreign');
    expect(instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    Object.defineProperty(window.history, 'pushState', descriptor);
    const another = client({ captureNavigation: true });
    another.instance.destroy();
    expect(Object.getOwnPropertyDescriptor(window.history, 'pushState')).toEqual(descriptor);
  });

  it('leaves pre-existing History accessors and setters untouched without partial installation', () => {
    for (const key of ['pushState', 'replaceState'] as const) {
      const native = window.history[key];
      const getter = vi.fn(() => native);
      const setter = vi.fn();
      const descriptor: PropertyDescriptor = { configurable: true, enumerable: true, get: getter, set: setter };
      Object.defineProperty(window.history, key, descriptor);
      const { instance } = client({ captureNavigation: true });
      expect(getter).not.toHaveBeenCalled();
      expect(setter).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptor(window.history, key)).toEqual(descriptor);
      const other = key === 'pushState' ? 'replaceState' : 'pushState';
      expect(Object.getOwnPropertyDescriptor(window.history, other)).toBeUndefined();
      instance.destroy();
      expect(Object.getOwnPropertyDescriptor(window.history, key)).toEqual(descriptor);
      Reflect.deleteProperty(window.history, key);
    }
  });

  it('does not shadow an inherited read-only History method with a writable wrapper', () => {
    const descriptor = Object.getOwnPropertyDescriptor(History.prototype, 'pushState')!;
    expect(descriptor.writable).toBe(true);
    expect(Object.getOwnPropertyDescriptor(window.history, 'pushState')).toBeUndefined();
    const native = window.history.pushState;
    Object.defineProperty(History.prototype, 'pushState', { ...descriptor, writable: false });
    try {
      expect(Reflect.set(window.history, 'pushState', () => undefined)).toBe(false);
      const { instance } = client({ captureNavigation: true });
      expect(Object.getOwnPropertyDescriptor(window.history, 'pushState')).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(window.history, 'replaceState')).toBeUndefined();
      expect(window.history.pushState).toBe(native);
      instance.destroy();
      expect(Object.getOwnPropertyDescriptor(window.history, 'pushState')).toBeUndefined();
    } finally {
      Object.defineProperty(History.prototype, 'pushState', descriptor);
      Reflect.deleteProperty(window.history, 'pushState');
      Reflect.deleteProperty(window.history, 'replaceState');
    }
  });

  it('leaves a host getter that aliases the SDK wrapper untouched during cleanup', () => {
    const { instance } = client({ captureNavigation: true });
    const sdkWrapper = window.history.pushState;
    const getter = vi.fn(() => sdkWrapper);
    Object.defineProperty(window.history, 'pushState', { configurable: true, enumerable: true, get: getter });
    instance.destroy();
    const current = Object.getOwnPropertyDescriptor(window.history, 'pushState');
    expect(current?.get).toBe(getter);
    expect(current?.enumerable).toBe(true);
    expect(getter).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(window.history, 'replaceState')).toBeUndefined();
  });

  it('sanitizes each URL once per client, skips a failing filter, and keeps each trail separate', async () => {
    const calls: string[] = [];
    const first = client({ captureNavigation: true, sanitizeUrl: url => {
      calls.push(url);
      const value = new URL(url);
      value.username = 'user';
      value.password = 'secret';
      value.search = '?token=secret';
      value.hash = '#private';
      return value.href;
    } });
    const second = client({ captureNavigation: true, sanitizeUrl: url => {
      if (url.includes('/start')) throw new Error('blocked');
      return url;
    } });
    window.history.pushState(null, '', '/private?token=hidden#part');
    expect(calls).toHaveLength(2);
    first.instance.captureException(new Error('first'));
    second.instance.captureException(new Error('second'));
    await Promise.all([first.instance.flush(), second.instance.flush()]);
    expect(trail(first.batches)?.[0].data).toMatchObject({
      from: 'http://localhost:3000/start', to: 'http://localhost:3000/private', trigger: 'pushState',
    });
    expect(trail(second.batches)).toBeUndefined();
    expect(first.instance.getStats().dropped).toBe(0);
    expect(second.instance.getStats().dropped).toBe(0);
    expect(JSON.stringify(first.batches)).not.toMatch(/user:secret|token=|#private|#part/);
  });

  it('does not record a malformed sanitizer URL that could retain credentials', async () => {
    const { instance, batches } = client({ captureNavigation: true, sanitizeUrl: url =>
      url.includes('/start') ? 'http://user:secret@bad host/path?token=hidden' : url });
    window.history.pushState(null, '', '/next');
    instance.captureException(new Error('failure'));
    await instance.flush();
    expect(trail(batches)).toBeUndefined();
    expect(JSON.stringify(batches)).not.toMatch(/user:secret|token=hidden/);
  });

  it('respects clear, snapshot, beforeSend, and breadcrumb budgets', async () => {
    const { instance, batches } = client({ captureNavigation: true, beforeSend: event => {
      if (event.message === 'removed') event.breadcrumbs = undefined;
      return event;
    } });
    for (let index = 0; index < 22; index++) window.history.pushState(null, '', `/step-${index}`);
    instance.captureException(new Error('snapshot'));
    instance.captureException(new Error('removed'));
    instance.clearBreadcrumbs();
    instance.captureException(new Error('cleared'));
    await instance.flush();
    const [snapshot, removed, cleared] = batches[0].events;
    expect(snapshot.breadcrumbs).toHaveLength(BREADCRUMB_LIMITS.count);
    expect(snapshot.breadcrumbs?.[0].data?.to).toBe('http://localhost:3000/step-2');
    expect(new TextEncoder().encode(JSON.stringify(snapshot.breadcrumbs)).length).toBeLessThanOrEqual(BREADCRUMB_LIMITS.bytes);
    expect(isBreadcrumbTrail(snapshot.breadcrumbs)).toBe(true);
    expect(removed.breadcrumbs).toBeUndefined();
    expect(cleared.breadcrumbs).toBeUndefined();
  });

  it('does not instrument disabled, server, or destroyed clients', () => {
    const native = window.history.pushState;
    const disabled = client({ captureNavigation: true, enabled: false });
    expect(window.history.pushState).toBe(native);
    const serverWindow = window;
    vi.stubGlobal('window', undefined);
    const server = client({ captureNavigation: true });
    vi.stubGlobal('window', serverWindow);
    expect(window.history.pushState).toBe(native);
    const active = client({ captureNavigation: true });
    active.instance.destroy();
    expect(window.history.pushState).toBe(native);
    expect(disabled.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    expect(server.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    vi.unstubAllGlobals();
  });

  it('leaves no half-installed wrapper when History is locked', () => {
    const realHistory = window.history;
    const historyDescriptor = Object.getOwnPropertyDescriptor(window, 'history')!;
    const lockedPush = () => undefined;
    const replace = vi.fn();
    const locked = { replaceState: replace } as unknown as History;
    Object.defineProperty(locked, 'pushState', { configurable: false, writable: false, value: lockedPush });
    Object.defineProperty(window, 'history', { configurable: true, value: locked });
    try {
      const { instance } = client({ captureNavigation: true });
      expect(locked.pushState).toBe(lockedPush);
      expect(locked.replaceState).toBe(replace);
      instance.destroy();
    } finally {
      Object.defineProperty(window, 'history', historyDescriptor);
    }
    expect(window.history).toBe(realHistory);
    const active = client({ captureNavigation: true });
    expect(window.history.pushState).not.toBe(History.prototype.pushState);
    active.instance.destroy();
  });

  it('rolls back both wrappers and listeners when listener installation fails', () => {
    const originalAdd = window.addEventListener;
    const remove = vi.spyOn(window, 'removeEventListener');
    vi.spyOn(window, 'addEventListener').mockImplementation(function (this: Window,
      type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      if (type === 'hashchange') throw new Error('listener blocked');
      return Reflect.apply(originalAdd, this, [type, listener, options]);
    });
    const { instance } = client({ captureNavigation: true });
    expect(Object.getOwnPropertyDescriptor(window.history, 'pushState')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(window.history, 'replaceState')).toBeUndefined();
    expect(remove).toHaveBeenCalledWith('popstate', expect.any(Function));
    instance.destroy();
  });
});
