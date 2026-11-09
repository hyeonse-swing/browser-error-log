import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, type BrowserErrorLogClient } from './index';

const clients: BrowserErrorLogClient[] = [];

function client(overrides: Partial<Parameters<typeof init>[0]> = {}): BrowserErrorLogClient {
  const instance = init({
    project: 'web', environment: 'test', release: '1.0.0',
    endpoint: '/collect', captureNetwork: false, ...overrides,
  });
  clients.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pagehide beacon', () => {
  it('sends queued events through the default transport while the document is visible', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const instance = client();
    instance.captureException('queued');

    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
  });

  it('does not send an event already accepted on hidden visibility', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const instance = client();
    instance.captureException('once');

    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
  });

  it.each(['reject', 'throw'] as const)('keeps events after a %s beacon for a normal flush', async outcome => {
    const sendBeacon = vi.fn(() => {
      if (outcome === 'throw') throw new Error('beacon unavailable');
      return false;
    });
    vi.stubGlobal('navigator', { sendBeacon });
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetch);
    const instance = client();
    instance.captureException('retry later');

    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 1, sent: 0, dropped: 0 });

    await instance.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
  });

  it('stays usable after persisted pagehide and removes its listener on destroy', async () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetch);
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const instance = client();
    const pageHideHandler = addListener.mock.calls.find(([name]) => name === 'pagehide')?.[1];
    expect(pageHideHandler).toBeDefined();
    instance.captureException('before cache');

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    expect(instance.getStats()).toEqual({ queued: 0, sent: 1, dropped: 0 });
    instance.captureException('after cache');
    await instance.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(instance.getStats()).toEqual({ queued: 0, sent: 2, dropped: 0 });

    instance.destroy();
    expect(removeListener.mock.calls.some(([name, handler]) => name === 'pagehide' && handler === pageHideHandler)).toBe(true);
    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['custom transport', { transport: vi.fn() }],
    ['cross-origin endpoint', { endpoint: 'https://other.example/collect' }],
    ['explicitly offline', { pauseWhileOffline: true }],
  ] as const)('shares beacon eligibility for %s', (_name, overrides) => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon, onLine: false });
    const instance = client(overrides);
    instance.captureException('queued');

    window.dispatchEvent(new Event('pagehide'));

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(instance.getStats()).toEqual({ queued: 1, sent: 0, dropped: 0 });
  });

  it('does not attach a pagehide listener for disabled or server clients', () => {
    const addListener = vi.spyOn(window, 'addEventListener');
    const disabled = client({ enabled: false });
    vi.stubGlobal('window', undefined);
    const server = client();
    vi.unstubAllGlobals();

    expect(addListener.mock.calls.filter(([name]) => name === 'pagehide')).toHaveLength(0);
    expect(disabled.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    expect(server.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
  });
});
