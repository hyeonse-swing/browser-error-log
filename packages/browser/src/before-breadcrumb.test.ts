import { afterEach, describe, expect, it, vi } from 'vitest';
import { BREADCRUMB_LIMITS, isBreadcrumbTrail, type EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogOptions } from './index';

const clients: ReturnType<typeof init>[] = [];
function client(options: Partial<BrowserErrorLogOptions> = {}) {
  const batches: EventBatch[] = [];
  const instance = init({ project: 'hook-test', transport: batch => { batches.push(batch); },
    captureNetwork: false, ...options });
  clients.push(instance);
  return { instance, batches };
}
async function capture(instance: ReturnType<typeof init>, batches: EventBatch[]) {
  instance.captureException(new Error('after'));
  await instance.flush();
  return batches.flatMap(batch => batch.events);
}
afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('beforeBreadcrumb', () => {
  it('keeps default manual behavior and applies mutation or replacement to isolated canonical input', async () => {
    const plain = client();
    plain.instance.addBreadcrumb({ message: 'plain' });
    expect((await capture(plain.instance, plain.batches))[0].breadcrumbs?.[0]).toMatchObject({ category: 'manual', message: 'plain' });

    let retained: any;
    const hooked = client({ beforeBreadcrumb: crumb => {
      retained = crumb;
      expect(crumb).toMatchObject({ category: 'manual', message: 'GET /private', data: { email: '[REDACTED_EMAIL]' } });
      crumb.message = 'mutated';
      crumb.data!.email = 'changed';
      return undefined;
    } });
    const input = { message: 'GET /private?token=hidden', data: { email: 'bob@example.com' } };
    hooked.instance.addBreadcrumb(input);
    input.data.email = 'later@example.com';
    const first = (await capture(hooked.instance, hooked.batches))[0];
    retained.message = 'late change';
    retained.data.email = 'late change';
    hooked.instance.captureException(new Error('again'));
    await hooked.instance.flush();
    expect(first.breadcrumbs?.[0]).toMatchObject({ message: 'mutated', data: { email: 'changed' } });
    expect(hooked.batches.at(-1)?.events[0].breadcrumbs?.[0].message).toBe('mutated');
    expect(hooked.batches.at(-1)?.events[0].breadcrumbs?.[0].data?.email).toBe('changed');

    const replacement = client({ beforeBreadcrumb: () => ({ category: 'custom', message: 'replacement', data: { ok: true }, extra: 'discard' }) });
    replacement.instance.addBreadcrumb({ message: 'original' });
    const crumb = (await capture(replacement.instance, replacement.batches))[0].breadcrumbs?.[0];
    expect(crumb).toMatchObject({ category: 'custom', message: 'replacement', data: { ok: true } });
    expect(crumb).not.toHaveProperty('extra');
  });

  it('omits vetoed, thrown, and invalid crumbs without changing diagnostics or beforeSend', async () => {
    const beforeSend = vi.fn(event => event);
    const instance = client({ beforeSend, beforeBreadcrumb: crumb => {
      if (crumb.message === 'false') return false;
      if (crumb.message === 'null') return null;
      if (crumb.message === 'throw') throw new Error('hook');
      if (crumb.message === 'invalid') return { message: ' ' };
      return crumb;
    } });
    for (const message of ['false', 'null', 'throw', 'invalid', 'kept']) instance.instance.addBreadcrumb({ message });
    expect(instance.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    const events = await capture(instance.instance, instance.batches);
    expect(events[0].breadcrumbs?.map(crumb => crumb.message)).toEqual(['kept']);
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(instance.instance.getDiagnostics()).toMatchObject({ sent: 1, dropped: 0, filtered: 0 });
  });

  it('re-cleans replacement and mutation, preserves SDK time, and bounds the trail', async () => {
    const instance = client({ beforeBreadcrumb: crumb => {
      crumb.occurredAt = '2000-01-01T00:00:00.000Z';
      return { ...crumb, message: `GET /private?token=hidden ${'한'.repeat(300)}`,
        data: { password: 'secret', email: 'bob@example.com', auth: 'Bearer abc',
          url: 'https://user:pass@example.com/path?token=hidden#part' } };
    } });
    for (let i = 0; i < 24; i++) instance.instance.addBreadcrumb({ message: `step ${i}` });
    const trail = (await capture(instance.instance, instance.batches))[0].breadcrumbs!;
    expect(isBreadcrumbTrail(trail)).toBe(true);
    expect(trail.length).toBeLessThanOrEqual(BREADCRUMB_LIMITS.count);
    expect(new TextEncoder().encode(JSON.stringify(trail)).length).toBeLessThanOrEqual(BREADCRUMB_LIMITS.bytes);
    expect(trail[0].occurredAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(JSON.stringify(trail)).not.toMatch(/password|secret|bob@example.com|Bearer abc|token=hidden|user:pass/);
  });

  it('recovers from reentrant calls and permits clear while suppressing nested breadcrumbs', async () => {
    let instance!: ReturnType<typeof init>;
    let calls = 0;
    const created = client({ beforeBreadcrumb: crumb => {
      calls++;
      instance.addBreadcrumb({ message: 'nested' });
      if (crumb.message === 'reset') instance.clearBreadcrumbs();
      return crumb;
    } });
    instance = created.instance;
    instance.addBreadcrumb({ message: 'old' });
    instance.addBreadcrumb({ message: 'reset' });
    instance.addBreadcrumb({ message: 'later' });
    expect(calls).toBe(3);
    expect((await capture(instance, created.batches))[0].breadcrumbs?.map(crumb => crumb.message)).toEqual(['reset', 'later']);
  });

  it('does not append after destruction and keeps hooks separate by client', async () => {
    let first!: ReturnType<typeof init>;
    const firstHook = vi.fn(crumb => { first.destroy(); return crumb; });
    const a = client({ beforeBreadcrumb: firstHook });
    first = a.instance;
    const secondHook = vi.fn(crumb => crumb);
    const b = client({ beforeBreadcrumb: secondHook });
    first.addBreadcrumb({ message: 'gone' });
    b.instance.addBreadcrumb({ message: 'retained' });
    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).toHaveBeenCalledTimes(1);
    expect((await capture(b.instance, b.batches))[0].breadcrumbs?.map(crumb => crumb.message)).toEqual(['retained']);
  });

  it('runs once for navigation and fetch completion, not for later capture or flush', async () => {
    const hook = vi.fn(crumb => crumb);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
    const { instance, batches } = client({ captureNavigation: true, captureNetworkBreadcrumbs: true,
      endpoint: '/collector', beforeBreadcrumb: hook });
    window.history.pushState(null, '', '/before-breadcrumb-route');
    await window.fetch('/before-breadcrumb-fetch');
    expect(hook.mock.calls.map(call => call[0].category)).toEqual(['navigation', 'http']);
    expect(hook.mock.calls[0][0].data?.to).toBe('http://localhost:3000/before-breadcrumb-route');
    expect(hook.mock.calls[1][0].data?.url).toBe('http://localhost:3000/before-breadcrumb-fetch');
    const events = await capture(instance, batches);
    await instance.flush();
    expect(hook).toHaveBeenCalledTimes(2);
    expect(events[0].breadcrumbs?.map(crumb => crumb.category)).toEqual(['navigation', 'http']);
  });

  it('preserves selected HTTP and network errors when the breadcrumb hook omits them', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('offline')
      ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(null, { status: 503 }))));
    const { instance, batches } = client({ captureNetwork: true, captureNetworkBreadcrumbs: true,
      endpoint: '/collector', beforeBreadcrumb: () => false });
    await window.fetch('/failure');
    await expect(window.fetch('/offline')).rejects.toThrow('offline');
    await instance.flush();
    expect(batches.flatMap(batch => batch.events).map(event => event.type)).toEqual(['http', 'network']);
    expect(batches.flatMap(batch => batch.events).every(event => event.breadcrumbs === undefined)).toBe(true);
    expect(instance.getStats()).toMatchObject({ sent: 2, dropped: 0 });
  });

  it('does not let a throwing replacement sanitizer suppress a selected HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))));
    const { instance, batches } = client({ captureNetwork: true, captureNetworkBreadcrumbs: true,
      endpoint: '/collector', beforeBreadcrumb: () => ({ message: 'GET /bad-hook?token=hidden' }),
      sanitizeUrl: url => { if (url.includes('/bad-hook')) throw new Error('unsafe'); return url; } });
    await window.fetch('/failure');
    await instance.flush();
    expect(batches.flatMap(batch => batch.events).map(event => event.type)).toEqual(['http']);
    expect(batches[0].events[0].breadcrumbs).toBeUndefined();
    expect(instance.getDiagnostics()).toMatchObject({ sent: 1, dropped: 0 });
  });

  it('blocks nested calls from replacement getters and recovers on the next call', async () => {
    let instance!: ReturnType<typeof init>;
    let calls = 0;
    const created = client({ beforeBreadcrumb: crumb => {
      calls++;
      if (crumb.message !== 'first') return crumb;
      return { get message() { instance.addBreadcrumb({ message: 'nested getter' }); return 'first cleaned'; } };
    } });
    instance = created.instance;
    instance.addBreadcrumb({ message: 'first' });
    instance.addBreadcrumb({ message: 'second' });
    expect(calls).toBe(2);
    expect((await capture(instance, created.batches))[0].breadcrumbs?.map(crumb => crumb.message)).toEqual(['first cleaned', 'second']);
  });

  it('records XHR completion through the hook once', async () => {
    class FakeXHR extends EventTarget {
      status = 200;
      open(_method: string, _url: string): void {}
      send(): void { this.dispatchEvent(new Event('load')); this.dispatchEvent(new Event('loadend')); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const hook = vi.fn(crumb => crumb);
    const { instance, batches } = client({ captureNetworkBreadcrumbs: true, endpoint: '/collector', beforeBreadcrumb: hook });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/xhr-hook?token=hidden');
    xhr.send();
    const events = await capture(instance, batches);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(events[0].breadcrumbs?.[0].data).toMatchObject({ method: 'POST', url: 'http://localhost:3000/xhr-hook', status: 200 });
  });

  it('does not invoke hooks on disabled, server-side, or destroyed clients', () => {
    const hook = vi.fn(crumb => crumb);
    const disabled = client({ enabled: false, beforeBreadcrumb: hook });
    disabled.instance.addBreadcrumb({ message: 'disabled' });
    const browserWindow = window;
    vi.stubGlobal('window', undefined);
    const server = client({ beforeBreadcrumb: hook });
    server.instance.addBreadcrumb({ message: 'server' });
    vi.stubGlobal('window', browserWindow);
    const destroyed = client({ beforeBreadcrumb: hook });
    destroyed.instance.destroy();
    destroyed.instance.addBreadcrumb({ message: 'destroyed' });
    expect(hook).not.toHaveBeenCalled();
  });

  it('keeps queued snapshots separate from retained hook data and beforeSend changes', async () => {
    let retained: any;
    const hook = vi.fn(crumb => { retained = crumb; return undefined; });
    const beforeSend = vi.fn(event => {
      if (event.message === 'first') event.breadcrumbs?.[0].data && (event.breadcrumbs[0].data!.state = 'event only');
      return event;
    });
    const { instance, batches } = client({ beforeBreadcrumb: hook, beforeSend });
    instance.addBreadcrumb({ message: 'step', data: { state: 'initial' } });
    instance.captureException(new Error('first'));
    retained.data.state = 'retained change';
    instance.captureException(new Error('second'));
    await instance.flush();
    const [first, second] = batches.flatMap(batch => batch.events);
    expect(first.breadcrumbs?.[0].data?.state).toBe('event only');
    expect(second.breadcrumbs?.[0].data?.state).toBe('initial');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(beforeSend).toHaveBeenCalledTimes(2);
  });
});
