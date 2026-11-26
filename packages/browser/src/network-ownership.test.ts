import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogCaptureClient } from './index';

const clients: BrowserErrorLogCaptureClient[] = [];

function client(project: string) {
  const batches: EventBatch[] = [];
  const instance = init({ project, endpoint: '/collector', transport: batch => { batches.push(batch); } });
  clients.push(instance);
  return { instance, events: () => batches.flatMap(batch => batch.events) };
}

afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('network request ownership', () => {
  it('does not report another client’s collector retry or breadcrumb as an application failure', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const deliveries: EventBatch[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/collector-b')) deliveries.push(JSON.parse(String(options?.body)) as EventBatch);
      const status = url.endsWith('/collector-a') && calls.filter(item => item === url).length === 1 ? 503
        : url === '/application-failure' ? 503 : 204;
      return Promise.resolve(new Response(null, { status }));
    }));
    const first = init({ project: 'A', endpoint: '/collector-a', captureNetwork: false });
    const second = init({ project: 'B', endpoint: '/collector-b', captureNetworkBreadcrumbs: true });
    clients.push(first, second);

    first.captureException(new Error('original failure'));
    const sending = first.flush();
    await vi.advanceTimersByTimeAsync(250);
    await sending;
    expect(calls).toEqual(['http://localhost:3000/collector-a', 'http://localhost:3000/collector-a']);
    expect(first.getStats().sent).toBe(1);
    expect(second.getStats().queued).toBe(0);

    second.captureException(new Error('before application request'));
    await window.fetch('/application-failure');
    expect(second.getStats().queued).toBe(2);
    await second.flush();
    expect(calls.at(-1)).toBe('http://localhost:3000/collector-b');
    expect(second.getStats()).toMatchObject({ queued: 0, sent: 2 });
    expect(deliveries.flatMap(batch => batch.events).map(event => event.type)).toEqual(['manual', 'http']);
    expect(deliveries[0]?.events[0]?.breadcrumbs).toBeUndefined();
  });

  it('keeps XHR collector classification through disposal and captures later unrelated requests', async () => {
    class FakeXHR extends EventTarget {
      status = 0;
      open(_method: string, _url: string): void {}
      send(): void {}
      finish(status: number): void {
        this.status = status;
        this.dispatchEvent(new Event('loadend'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const first = init({ project: 'A', endpoint: '/collector-a', captureNetwork: false });
    clients.push(first);
    const second = client('B');
    const collector = new XMLHttpRequest() as XMLHttpRequest & FakeXHR;
    collector.open('POST', '/collector-a');
    collector.send();
    first.destroy();
    collector.finish(503);
    expect(second.instance.getStats().queued).toBe(0);

    const application = new XMLHttpRequest() as XMLHttpRequest & FakeXHR;
    application.open('GET', '/application-failure');
    application.send();
    application.finish(503);
    await second.instance.flush();
    expect(second.events().map(event => event.network?.url)).toEqual(['http://localhost:3000/application-failure']);
  });

  for (const withControl of [false, true]) {
    it(`attributes a late fetch response to request-start clients with control=${withControl}`, async () => {
      let finishFirst!: (response: Response) => void;
      vi.stubGlobal('fetch', vi.fn((url: string) => url === '/first'
        ? new Promise<Response>(resolve => { finishFirst = resolve; })
        : Promise.resolve(new Response(null, { status: 503 }))));

      const first = client('A');
      const control = withControl ? client('C') : undefined;
      const pending = window.fetch('/first');
      first.instance.destroy();
      const replacement = client('B');
      finishFirst(new Response(null, { status: 503 }));
      await pending;

      expect(replacement.instance.getStats().queued).toBe(0);
      expect(control?.instance.getStats().queued ?? 0).toBe(withControl ? 1 : 0);
      await window.fetch('/second');
      await replacement.instance.flush();
      await control?.instance.flush();
      expect(replacement.events().map(event => [event.project, event.network?.url])).toEqual([
        ['B', 'http://localhost:3000/second'],
      ]);
      expect(control?.events().map(event => [event.project, event.network?.url]) ?? []).toEqual(withControl
        ? [['C', 'http://localhost:3000/first'], ['C', 'http://localhost:3000/second']]
        : []);
    });

    it(`attributes a late fetch rejection to request-start clients with control=${withControl}`, async () => {
      let failFirst!: (reason: unknown) => void;
      vi.stubGlobal('fetch', vi.fn((url: string) => url === '/first'
        ? new Promise<Response>((_resolve, reject) => { failFirst = reject; })
        : Promise.resolve(new Response(null, { status: 200 }))));

      const first = client('A');
      const control = withControl ? client('C') : undefined;
      const pending = window.fetch('/first');
      first.instance.destroy();
      const replacement = client('B');
      failFirst(new TypeError('offline'));
      await expect(pending).rejects.toThrow('offline');

      expect(replacement.instance.getStats().queued).toBe(0);
      expect(control?.instance.getStats().queued ?? 0).toBe(withControl ? 1 : 0);
      await replacement.instance.flush();
      await control?.instance.flush();
      expect(replacement.events()).toEqual([]);
      expect(control?.events().map(event => [event.project, event.type]) ?? []).toEqual(withControl
        ? [['C', 'network']] : []);
    });

    it(`attributes a synchronous fetch throw to clients active before the call with control=${withControl}`, async () => {
      let switchClients!: () => void;
      vi.stubGlobal('fetch', vi.fn(() => {
        switchClients();
        throw new TypeError('synchronous failure');
      }));
      const first = client('A');
      const control = withControl ? client('C') : undefined;
      let replacement!: ReturnType<typeof client>;
      switchClients = () => { first.instance.destroy(); replacement = client('B'); };

      expect(() => window.fetch('/first')).toThrow('synchronous failure');
      expect(replacement.instance.getStats().queued).toBe(0);
      expect(control?.instance.getStats().queued ?? 0).toBe(withControl ? 1 : 0);
      await control?.instance.flush();
      expect(control?.events().map(event => [event.project, event.type]) ?? []).toEqual(withControl
        ? [['C', 'network']] : []);
    });

    it(`attributes a late XHR failure to send-time clients with control=${withControl}`, async () => {
      class FakeXHR extends EventTarget {
        status = 0;
        open(_method: string, _url: string): void {}
        send(): void {}
        finish(status: number): void {
          this.status = status;
          this.dispatchEvent(new Event(status === 0 ? 'error' : 'load'));
          this.dispatchEvent(new Event('loadend'));
        }
      }
      vi.stubGlobal('XMLHttpRequest', FakeXHR);
      const first = client('A');
      const control = withControl ? client('C') : undefined;
      const pending = new XMLHttpRequest() as XMLHttpRequest & FakeXHR;
      pending.open('GET', '/first');
      pending.send();
      first.instance.destroy();
      const replacement = client('B');
      pending.finish(503);

      expect(replacement.instance.getStats().queued).toBe(0);
      expect(control?.instance.getStats().queued ?? 0).toBe(withControl ? 1 : 0);
      const next = new XMLHttpRequest() as XMLHttpRequest & FakeXHR;
      next.open('GET', '/second');
      next.send();
      next.finish(503);
      await replacement.instance.flush();
      await control?.instance.flush();
      expect(replacement.events().map(event => [event.project, event.network?.url])).toEqual([
        ['B', 'http://localhost:3000/second'],
      ]);
      expect(control?.events().map(event => [event.project, event.network?.url]) ?? []).toEqual(withControl
        ? [['C', 'http://localhost:3000/first'], ['C', 'http://localhost:3000/second']]
        : []);
    });
  }
});
