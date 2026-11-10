import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogDiagnosticsClient, type BrowserErrorLogOptions } from './index';

const clients: BrowserErrorLogDiagnosticsClient[] = [];
function client(overrides: Partial<BrowserErrorLogOptions> = {}) {
  const batches: EventBatch[] = [];
  const options: BrowserErrorLogOptions = { project: 'test', captureNetwork: false,
    transport: batch => { batches.push(batch); }, ...overrides };
  const instance = init(options);
  clients.push(instance);
  return { instance, options, events: () => batches.flatMap(batch => batch.events) };
}
afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.restoreAllMocks();
});

describe('ignoreMessages', () => {
  it('defaults to no filtering and ignores invalid lists and entries', async () => {
    const plain = client();
    const malformed = client({ ignoreMessages: 'block' as unknown as readonly string[] });
    const entries = client({ ignoreMessages: ['', 4, null, 'block'] as unknown as readonly string[] });
    plain.instance.captureException('block');
    malformed.instance.captureException('block');
    entries.instance.captureException('allow');
    entries.instance.captureException('block');
    await Promise.all([plain.instance.flush(), malformed.instance.flush(), entries.instance.flush()]);
    expect(plain.events().map(event => event.message)).toEqual(['block']);
    expect(malformed.events().map(event => event.message)).toEqual(['block']);
    expect(entries.events().map(event => event.message)).toEqual(['allow']);
    expect(entries.instance.getDiagnostics()).toMatchObject({ filtered: 1, dropped: 0 });
  });

  it('matches literal case-sensitive substrings and counts overlapping patterns once', async () => {
    const ignoreMessages = ['TypeError', 'Error', ' spaced '] as const;
    const { instance, events } = client({ ignoreMessages });
    for (const message of ['prefix TypeError suffix', 'typeerror', 'spaced', 'a spaced b']) {
      instance.captureException(message);
    }
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['typeerror', 'spaced']);
    expect(instance.getDiagnostics()).toMatchObject({ filtered: 2, dropped: 0, deduplicated: 0 });
  });

  it('snapshots the list even when the original array and option are changed', async () => {
    const list = ['old'];
    const { instance, options, events } = client({ ignoreMessages: list });
    list[0] = 'new';
    list.push('later');
    options.ignoreMessages = ['replacement'];
    for (const message of ['old', 'new', 'later', 'replacement']) instance.captureException(message);
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['new', 'later', 'replacement']);
    expect(instance.getDiagnostics().filtered).toBe(1);
  });

  it('matches the sanitized final hook message and never name, stack, or context', async () => {
    const { instance, events } = client({ ignoreMessages: ['secret', 'visit https://example.test/path',
      'replacement https://example.test/path'],
      beforeSend: event => {
        if (event.message === 'rewrite') event.message = 'replacement https://example.test/path?token=secret';
        return event;
      } });
    instance.captureException('rewrite');
    instance.captureException('visit https://example.test/path?token=secret');
    instance.captureException('other https://example.test/path?token=secret');
    instance.captureException('safe', { context: { note: 'secret' } });
    const error = new Error('safe error');
    error.name = 'secret';
    error.stack = 'secret stack';
    instance.captureException(error);
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['other https://example.test/path', 'safe', 'safe error']);
    expect(instance.getDiagnostics()).toMatchObject({ filtered: 2, dropped: 0 });
  });

  it('does not mark an ignored Error object as seen', async () => {
    const { instance, events } = client({ ignoreMessages: ['ignore'] });
    const error = new Error('ignore');
    instance.captureException(error);
    error.message = 'admit';
    instance.captureException(error);
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['admit']);
    expect(instance.getDiagnostics()).toMatchObject({ filtered: 1, deduplicated: 0 });
  });

  it('does not spend rate or value dedupe budget and keeps full quota ahead of the hook', async () => {
    const beforeSend = vi.fn(event => event);
    const { instance, events } = client({ ignoreMessages: ['ignore'], dedupeIntervalMs: 60_000,
      maxEventsPerMinute: 1, beforeSend });
    instance.captureException('ignore');
    instance.captureException('admit');
    instance.captureException('ignore');
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['admit']);
    expect(beforeSend).toHaveBeenCalledTimes(2);
    expect(instance.getDiagnostics()).toMatchObject({ filtered: 1, deduplicated: 0, dropped: 1,
      droppedByReason: { rateLimit: 1, processingError: 0 } });
  });

  it('preserves hook veto, throw, and destruction outcomes', () => {
    let instance!: BrowserErrorLogDiagnosticsClient;
    instance = client({ ignoreMessages: ['ignore'], beforeSend: event => {
      if (event.message === 'veto') return false;
      if (event.message === 'throw') throw Error('hook');
      if (event.message === 'destroy') instance.destroy();
      return event;
    } }).instance;
    for (const message of ['veto', 'throw', 'destroy']) instance.captureException(message);
    expect(instance.getDiagnostics()).toMatchObject({ filtered: 1, dropped: 1,
      droppedByReason: { processingError: 1 } });
  });

  it('applies to automatically captured global errors', async () => {
    const { instance, events } = client({ ignoreMessages: ['global ignore'] });
    window.dispatchEvent(new ErrorEvent('error', { message: 'global ignore' }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'global allow' }));
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['global allow']);
    expect(instance.getDiagnostics().filtered).toBe(1);
  });
});
