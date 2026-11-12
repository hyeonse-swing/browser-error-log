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

function globalError(message = 'script error') {
  const event = new ErrorEvent('error', { message, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

function reject(reason: unknown) {
  const event = new Event('unhandledrejection', { cancelable: true });
  Object.defineProperty(event, 'reason', { value: reason });
  window.dispatchEvent(event);
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const instance of clients.splice(0)) instance.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('captureGlobalErrors', () => {
  it('captures global JavaScript errors when omitted or true', async () => {
    const omitted = client();
    const enabled = client({ captureGlobalErrors: true });
    globalError();
    await Promise.all([omitted.instance.flush(), enabled.instance.flush()]);
    expect(omitted.events().map(event => event.type)).toEqual(['javascript']);
    expect(enabled.events().map(event => event.type)).toEqual(['javascript']);
  });

  it('skips the global event before callbacks and quota while a peer captures it', async () => {
    const beforeSend = vi.fn(event => event);
    const skipped = client({ captureGlobalErrors: false, beforeSend, maxEventsPerMinute: 1 });
    const peer = client();
    globalError();
    expect(skipped.instance.getDiagnostics()).toMatchObject({ queued: 0, sent: 0, dropped: 0,
      filtered: 0, deduplicated: 0 });
    expect(beforeSend).not.toHaveBeenCalled();
    skipped.instance.captureException('manual after skip', { type: 'javascript' });
    await Promise.all([skipped.instance.flush(), peer.instance.flush()]);
    expect(skipped.events().map(event => [event.type, event.message]))
      .toEqual([['javascript', 'manual after skip']]);
    expect(peer.events().map(event => event.type)).toEqual(['javascript']);
    expect(skipped.instance.getDiagnostics()).toMatchObject({ sent: 1, dropped: 0 });
  });

  it('still captures automatic promise rejections', async () => {
    const { instance, events } = client({ captureGlobalErrors: false });
    reject('promise failure');
    await instance.flush();
    expect(events().map(event => [event.type, event.message])).toEqual([['promise', 'promise failure']]);
  });

  it('still captures DOM image load errors through the separate capture listener', async () => {
    const { instance, events } = client({ captureGlobalErrors: false, captureResourceErrors: true });
    const img = document.createElement('img');
    img.src = 'https://example.com/image.png';
    document.body.append(img);
    img.dispatchEvent(new Event('error', { bubbles: true }));
    await instance.flush();
    expect(events().map(event => event.type)).toEqual(['resource']);
    expect(events()[0].context?.resourceUrl).toBe('https://example.com/image.png');
  });

  it('snapshots opt-out and opt-in despite later option mutation', async () => {
    const skipped = client({ captureGlobalErrors: false });
    const captured = client({ captureGlobalErrors: true });
    skipped.options.captureGlobalErrors = true;
    captured.options.captureGlobalErrors = false;
    globalError();
    await Promise.all([skipped.instance.flush(), captured.instance.flush()]);
    expect(skipped.events()).toEqual([]);
    expect(captured.events().map(event => event.type)).toEqual(['javascript']);
  });

  it('unregisters only the bubbling listener each client registered', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const skipped = client({ captureGlobalErrors: false, captureResourceErrors: true });
    const captured = client({ captureGlobalErrors: true, captureResourceErrors: true });
    const errorAdds = add.mock.calls.filter(([type]) => type === 'error');
    expect(errorAdds.filter(([, , capture]) => capture === true)).toHaveLength(2);
    expect(errorAdds.filter(([, , capture]) => capture !== true)).toHaveLength(1);
    skipped.options.captureGlobalErrors = true;
    captured.options.captureGlobalErrors = false;
    skipped.instance.destroy();
    captured.instance.destroy();
    expect(remove.mock.calls.filter(([type]) => type === 'error')).toEqual(errorAdds);
  });

  it('leaves external listeners and native default handling intact', () => {
    const listener = vi.fn();
    window.addEventListener('error', listener);
    try {
      client({ captureGlobalErrors: false });
      const event = globalError();
      expect(listener).toHaveBeenCalledWith(event);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener('error', listener);
    }
  });

  it('keeps disabled and SSR clients inert without bubbling listeners', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const disabled = client({ enabled: false });
    vi.stubGlobal('window', undefined);
    const server = client();
    vi.unstubAllGlobals();
    expect(add.mock.calls.filter(([type]) => type === 'error')).toEqual([]);
    disabled.instance.captureException('disabled');
    server.instance.captureException('server');
    expect(disabled.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
    expect(server.instance.getStats()).toEqual({ queued: 0, sent: 0, dropped: 0 });
  });
});
