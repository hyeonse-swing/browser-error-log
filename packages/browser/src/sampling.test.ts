import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogDiagnosticsClient, type BrowserErrorLogOptions } from './index';

const clients: BrowserErrorLogDiagnosticsClient[] = [];
let nextId = 0;
beforeEach(() => {
  // Isolate sampling draws from the existing ID-generation fallback.
  vi.stubGlobal('crypto', { randomUUID: () => `sampling-test-${++nextId}` });
});
afterEach(() => {
  for (const instance of clients.splice(0)) instance.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function client(overrides: Partial<BrowserErrorLogOptions> = {}) {
  const batches: EventBatch[] = [];
  const options: BrowserErrorLogOptions = {
    project: 'test', captureNetwork: false,
    transport: batch => { batches.push(batch); }, ...overrides,
  };
  const instance = init(options);
  clients.push(instance);
  return { instance, options, events: () => batches.flatMap(batch => batch.events) };
}

describe('sampleRate', () => {
  it('defaults to all events and selects none at zero without a sampling draw; hooks still run', () => {
    const random = vi.spyOn(Math, 'random');
    const hook = vi.fn(event => event);
    const all = client({ beforeSend: hook });
    const none = client({ sampleRate: 0, beforeSend: hook });
    all.instance.captureException('all');
    none.instance.captureException('none');
    expect(all.instance.getDiagnostics()).toMatchObject({ queued: 1, filtered: 0 });
    expect(none.instance.getDiagnostics()).toMatchObject({ queued: 0, filtered: 1, dropped: 0 });
    expect(hook).toHaveBeenCalledTimes(2);
    expect(random).not.toHaveBeenCalled();
  });

  it('keeps ID fallback draws at zero and one without an additional sampling draw', async () => {
    vi.stubGlobal('crypto', {});
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const all = client({ sampleRate: 1 });
    const none = client({ sampleRate: 0 });
    expect(random).toHaveBeenCalledTimes(2); // Two view IDs.
    all.instance.captureException('included');
    none.instance.captureException('excluded');
    expect(random).toHaveBeenCalledTimes(4); // Two event IDs, no sampling draws.
    await all.instance.flush();
    expect(all.events().map(event => event.message)).toEqual(['included']);
    expect(none.instance.getDiagnostics()).toMatchObject({ queued: 0, filtered: 1, dropped: 0 });
    expect(random).toHaveBeenCalledTimes(4);
  });

  it('keeps fractional precision and selects only draws strictly below the boundary', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0.2499).mockReturnValueOnce(0.9);
    const { instance, events } = client({ sampleRate: 0.25 });
    for (const message of ['zero', 'boundary', 'below', 'above']) instance.captureException(message);
    await instance.flush();
    expect(events().map(event => event.message)).toEqual(['zero', 'below']);
    expect(instance.getDiagnostics()).toMatchObject({ filtered: 2, dropped: 0, deduplicated: 0 });
    expect(random).toHaveBeenCalledTimes(4);
  });

  it.each([undefined, NaN, Infinity, -Infinity, '0.5' as unknown as number])(
    'treats invalid or absent %s as all without a sampling draw', sampleRate => {
      const random = vi.spyOn(Math, 'random');
      const { instance } = client({ sampleRate });
      instance.captureException('included');
      expect(instance.getDiagnostics()).toMatchObject({ queued: 1, filtered: 0 });
      expect(random).not.toHaveBeenCalled();
    });

  it('clamps out of range values and snapshots the option at init', () => {
    const random = vi.spyOn(Math, 'random');
    const below = client({ sampleRate: -1 });
    const above = client({ sampleRate: 2 });
    below.options.sampleRate = 1;
    above.options.sampleRate = 0;
    below.instance.captureException('excluded');
    above.instance.captureException('included');
    expect(below.instance.getDiagnostics()).toMatchObject({ queued: 0, filtered: 1 });
    expect(above.instance.getDiagnostics()).toMatchObject({ queued: 1, filtered: 0 });
    expect(random).not.toHaveBeenCalled();
  });

  it('runs after hook veto and final sanitized ignore matching', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const hook = vi.fn((event: EventBatch['events'][number]) => {
      if (event.message === 'veto') return false;
      if (event.message === 'replace') event.message = 'ignore this';
      return event;
    });
    const { instance } = client({ sampleRate: 0.5, ignoreMessages: ['ignore'], beforeSend: hook });
    for (const message of ['veto', 'replace', 'sample']) instance.captureException(message);
    expect(instance.getDiagnostics()).toMatchObject({ queued: 0, filtered: 3, dropped: 0 });
    expect(hook).toHaveBeenCalledTimes(3);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('preserves the full rate precheck before hooks and sampling', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const hook = vi.fn(event => event);
    const { instance } = client({ sampleRate: 0.5, maxEventsPerMinute: 1, beforeSend: hook });
    instance.captureException('first');
    instance.captureException('full');
    expect(instance.getDiagnostics()).toMatchObject({ queued: 1, filtered: 0, droppedByReason: { rateLimit: 1 } });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('does not charge rate, value dedupe, or object identity for an unselected candidate', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.9).mockReturnValueOnce(0);
    const { instance } = client({ sampleRate: 0.5, maxEventsPerMinute: 1, dedupeIntervalMs: 1000 });
    const error = new Error('retry me');
    instance.captureException(error);
    instance.captureException(error);
    instance.captureException(error);
    expect(instance.getDiagnostics()).toMatchObject({ queued: 1, filtered: 1, deduplicated: 1,
      dropped: 0, droppedByReason: { rateLimit: 0 } });
    expect(random).toHaveBeenCalledTimes(2);
  });

  it('keeps hook throw and destroy outcomes before selection', () => {
    const random = vi.spyOn(Math, 'random');
    const throwing = client({ sampleRate: 0, beforeSend: () => { throw Error('hook'); } });
    throwing.instance.captureException('throw');
    let destroyed!: BrowserErrorLogDiagnosticsClient;
    destroyed = client({ sampleRate: 0, beforeSend: event => { destroyed.destroy(); return event; } }).instance;
    destroyed.captureException('destroy');
    expect(throwing.instance.getDiagnostics()).toMatchObject({ filtered: 0, droppedByReason: { processingError: 1 } });
    expect(destroyed.getDiagnostics()).toMatchObject({ filtered: 0, queued: 0, dropped: 0 });
    expect(random).not.toHaveBeenCalled();
  });

  it('samples automatically captured global errors through the same admission path', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { instance } = client({ sampleRate: 0.5 });
    window.dispatchEvent(new ErrorEvent('error', { message: 'automatic', error: new Error('automatic') }));
    expect(instance.getDiagnostics()).toMatchObject({ queued: 0, filtered: 1, dropped: 0 });
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('does not sample a delivery retry again', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const attempts: EventBatch[] = [];
    const { instance } = client({ sampleRate: 0.5, transport: batch => {
      attempts.push(batch);
      if (attempts.length === 1) throw { status: 429 };
    } });
    instance.captureException('retry');
    const pending = instance.flush();
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].events[0].eventId).toBe(attempts[1].events[0].eventId);
    expect(instance.getDiagnostics()).toMatchObject({ sent: 1, filtered: 0, dropped: 0 });
    expect(random).toHaveBeenCalledTimes(1);
  });
});
