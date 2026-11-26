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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('network request ownership', () => {
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
