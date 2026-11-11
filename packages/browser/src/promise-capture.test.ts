import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogDiagnosticsClient, type BrowserErrorLogOptions } from './index';

const clients: BrowserErrorLogDiagnosticsClient[] = [];

function client(overrides: Partial<BrowserErrorLogOptions> = {}) {
  const batches: EventBatch[] = [];
  const options: BrowserErrorLogOptions = {
    project: 'test', captureNetwork: false, transport: batch => { batches.push(batch); }, ...overrides,
  };
  const instance = init(options);
  clients.push(instance);
  return { instance, options, events: () => batches.flatMap(batch => batch.events) };
}

function reject(reason: unknown): Event {
  const event = new Event('unhandledrejection', { cancelable: true });
  Object.defineProperty(event, 'reason', { value: reason });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const instance of clients.splice(0)) instance.destroy();
  vi.restoreAllMocks();
});

describe('captureUnhandledRejections', () => {
  it('captures automatically when omitted or true', async () => {
    const omitted = client();
    const enabled = client({ captureUnhandledRejections: true });
    reject('automatic');
    await Promise.all([omitted.instance.flush(), enabled.instance.flush()]);
    expect(omitted.events().map(event => event.type)).toEqual(['promise']);
    expect(enabled.events().map(event => event.type)).toEqual(['promise']);
  });

  it('skips opt-out entirely while another default client continues capturing', async () => {
    const beforeSend = vi.fn(event => event);
    const skipped = client({ captureUnhandledRejections: false, beforeSend, maxEventsPerMinute: 1 });
    const defaultClient = client();
    reject('automatic');
    expect(skipped.instance.getDiagnostics()).toMatchObject({ queued: 0, sent: 0, dropped: 0,
      filtered: 0, deduplicated: 0 });
    expect(beforeSend).not.toHaveBeenCalled();
    skipped.instance.captureException('manual after skip');
    await Promise.all([skipped.instance.flush(), defaultClient.instance.flush()]);
    expect(skipped.events().map(event => event.message)).toEqual(['manual after skip']);
    expect(defaultClient.events().map(event => event.type)).toEqual(['promise']);
    expect(skipped.instance.getDiagnostics()).toMatchObject({ sent: 1, dropped: 0 });
  });

  it('keeps manual promise capture and global JavaScript error capture enabled', async () => {
    const { instance, events } = client({ captureUnhandledRejections: false });
    instance.captureException('manual promise', { type: 'promise' });
    window.dispatchEvent(new ErrorEvent('error', { message: 'script error' }));
    await instance.flush();
    expect(events().map(event => [event.type, event.message])).toEqual([
      ['promise', 'manual promise'], ['javascript', 'script error'],
    ]);
  });

  it('snapshots opt-out and opt-in despite later option mutation', async () => {
    const skipped = client({ captureUnhandledRejections: false });
    const captured = client({ captureUnhandledRejections: true });
    skipped.options.captureUnhandledRejections = true;
    captured.options.captureUnhandledRejections = false;
    reject('later mutation');
    await Promise.all([skipped.instance.flush(), captured.instance.flush()]);
    expect(skipped.events()).toEqual([]);
    expect(captured.events().map(event => event.type)).toEqual(['promise']);
  });

  it('removes only each registered rejection listener on destroy', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const skipped = client({ captureUnhandledRejections: false });
    const captured = client({ captureUnhandledRejections: true });
    const rejectionAdds = add.mock.calls.filter(([type]) => type === 'unhandledrejection');
    expect(rejectionAdds).toHaveLength(1);
    skipped.options.captureUnhandledRejections = true;
    captured.options.captureUnhandledRejections = false;
    skipped.instance.destroy();
    captured.instance.destroy();
    expect(remove.mock.calls.filter(([type]) => type === 'unhandledrejection'))
      .toEqual(rejectionAdds);
  });

  it('does not prevent default handling or hide the event from external listeners', () => {
    const listener = vi.fn();
    window.addEventListener('unhandledrejection', listener);
    try {
      client({ captureUnhandledRejections: false });
      const event = reject('external reason');
      expect(listener).toHaveBeenCalledWith(event);
      expect((listener.mock.calls[0][0] as Event & { reason: unknown }).reason).toBe('external reason');
      expect(event.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener('unhandledrejection', listener);
    }
  });

  it('keeps disabled and SSR clients inert', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const disabled = client({ enabled: false });
    vi.stubGlobal('window', undefined);
    const server = client();
    vi.unstubAllGlobals();
    expect(add.mock.calls.filter(([type]) => type === 'unhandledrejection')).toEqual([]);
    disabled.instance.captureException('disabled');
    server.instance.captureException('server');
    expect(disabled.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    expect(server.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
  });
});
