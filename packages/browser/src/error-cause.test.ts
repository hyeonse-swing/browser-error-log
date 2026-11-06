import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init, type BrowserErrorLogClient } from './index';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';

const clients: BrowserErrorLogClient[] = [];
const batches: EventBatch[] = [];
const create = (options: Partial<Parameters<typeof init>[0]> = {}) => {
  const instance = init({ project: 'web', transport: batch => { batches.push(JSON.parse(JSON.stringify(batch)) as EventBatch); },
    captureNetwork: false, ...options });
  clients.push(instance);
  return instance;
};
const events = () => batches.flatMap(batch => batch.events);
const withCause = (message: string, cause: unknown) => Object.assign(new Error(message), { cause });

beforeEach(() => { batches.length = 0; });
afterEach(() => { clients.splice(0).forEach(client => client.destroy()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('opt-in Error.cause collection', () => {
  it('defaults off without reading cause and snapshots the flag', async () => {
    const getter = vi.fn(() => new Error('inner'));
    const error = new Error('outer');
    Object.defineProperty(error, 'cause', { get: getter });
    const off = create();
    off.captureException(error);
    await off.flush();
    expect(getter).not.toHaveBeenCalled();
    expect(events()[0].stack).not.toContain('Caused by:');
    const options = { captureErrorCause: true };
    const on = create(options);
    options.captureErrorCause = false;
    on.captureException(error);
    await on.flush();
    expect(getter).toHaveBeenCalledOnce();
    expect(events()[1].stack).toContain('Caused by: Error: inner');
  });

  it('preserves outer identity and event count across nested manual, React, global and promise paths', async () => {
    const instance = create({ captureErrorCause: true });
    const error = withCause('outer', withCause('middle', new Error('inner')));
    instance.captureException(error);
    instance.captureException(withCause('react', new Error('react inner')), { type: 'react' });
    window.dispatchEvent(new ErrorEvent('error', { error: withCause('global', new Error('global inner')) }));
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: withCause('promise', new Error('promise inner')) });
    window.dispatchEvent(rejection);
    await instance.flush();
    expect(events().map(event => event.type)).toEqual(['manual', 'react', 'javascript', 'promise']);
    expect(events()[0]).toMatchObject({ message: 'outer', name: 'Error' });
    expect(events()[0].stack).toMatch(/Caused by: Error: middle[\s\S]*Caused by: Error: inner/);
    expect(events().slice(1).map(event => event.stack?.includes('Caused by: Error:'))).toEqual([true, true, true]);
  });

  it('enriches only the first existing same-realm console Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const instance = create({ captureConsole: true, captureErrorCause: true });
    const first = withCause('first', new Error('first inner'));
    const second = withCause('second', new Error('second inner'));
    console.error('oops', first, second);
    await instance.flush();
    expect(events()).toHaveLength(1);
    expect(events()[0].stack).toContain('first inner');
    expect(events()[0].stack).not.toContain('second inner');
  });

  it('drops a console event once when the first Error cause fails URL sanitization', async () => {
    const native = vi.spyOn(console, 'error').mockImplementation(() => {});
    const instance = create({ captureConsole: true, captureErrorCause: true, sanitizeUrl: url => {
      if (url.includes('/private/')) throw new Error('blocked');
      return url;
    } });
    const first = withCause('first', { message: 'inner', stack: 'at https://example.com/private/path?token=secret' });
    const second = withCause('second', new Error('second inner'));
    console.error(first, second);
    await instance.flush();
    expect(native).toHaveBeenCalledOnce();
    expect(events()).toHaveLength(0);
    expect(instance.getDiagnostics().droppedByReason.processingError).toBe(1);
    expect(instance.getStats().dropped).toBe(1);
  });

  it('accepts error-like cross-realm values and makes a header without an outer stack', async () => {
    const instance = create({ captureErrorCause: true });
    instance.captureException({ message: 'outer', name: 'Outer', cause: { message: 'inner', name: 'Remote', stack: 'remote trace' } });
    await instance.flush();
    expect(events()[0].stack).toBe('Outer: outer\nCaused by: Remote: inner\nremote trace');
  });

  it('ignores primitive and arbitrary payload causes without coercion or enumeration', async () => {
    const coercion = vi.fn(() => 'secret');
    const instance = create({ captureErrorCause: true });
    instance.captureException(withCause('primitive', 'private'));
    instance.captureException(withCause('payload', { payload: 'secret', toString: coercion }));
    await instance.flush();
    expect(events().map(event => event.stack?.includes('Caused by:'))).toEqual([false, false]);
    expect(coercion).not.toHaveBeenCalled();
  });

  it('stops cycles and does not read the fifth cause after four included causes', async () => {
    const instance = create({ captureErrorCause: true });
    const self = new Error('self') as Error & { cause?: unknown };
    self.cause = self;
    const a = withCause('a', null);
    const b = withCause('b', a);
    a.cause = b;
    const fifthRead = vi.fn(() => new Error('fifth'));
    const fourth = new Error('fourth');
    Object.defineProperty(fourth, 'cause', { get: fifthRead });
    instance.captureException(self);
    instance.captureException(a);
    instance.captureException(withCause('root', withCause('first', withCause('second', withCause('third', fourth)))));
    await instance.flush();
    expect(events()[0].stack).not.toContain('Caused by:');
    expect(events()[1].stack?.match(/Caused by:/g)).toHaveLength(1);
    expect(events()[2].stack?.match(/Caused by:/g)).toHaveLength(4);
    expect(fifthRead).not.toHaveBeenCalled();
  });

  it('tolerates hostile getters and proxies without host throws or drops', async () => {
    const instance = create({ captureErrorCause: true });
    const hostile = new Proxy({}, { get: () => { throw new Error('getter'); } });
    const brokenField = { get message() { throw new Error('bad message'); }, stack: 'trace' };
    expect(() => instance.captureException(withCause('outer', hostile))).not.toThrow();
    expect(() => instance.captureException(withCause('outer2', brokenField))).not.toThrow();
    await instance.flush();
    expect(events()).toHaveLength(2);
    expect(events()[0].stack).not.toContain('Caused by:');
    expect(events()[1].stack).toContain('Caused by: Error:');
    expect(instance.getStats().dropped).toBe(0);
  });

  it('bounds long stacks while preserving four cause headings', async () => {
    const instance = create({ captureErrorCause: true });
    let cause: unknown = undefined;
    for (let n = 4; n >= 1; n--) cause = { message: `inner${n}`, stack: `trace${n}${'x'.repeat(1000)}`, cause };
    instance.captureException({ message: 'outer', stack: 'outertrace' + 'x'.repeat(7000), cause });
    await instance.flush();
    const stack = events()[0].stack!;
    expect(stack.length).toBeLessThanOrEqual(4096);
    expect(stack).toContain('Caused by: Error: inner4');
    expect(stack).toContain('Caused by: Error: inner1');
    expect(stack.indexOf('inner1')).toBeLessThan(stack.indexOf('inner4'));
  });

  it('redacts URL credentials, query, hash, email and bearer content through custom path hooks', async () => {
    const hook = vi.fn((url: string) => url.replace('/private/', '/masked/'));
    const instance = create({ captureErrorCause: true, sanitizeUrl: hook });
    instance.captureException({ message: 'outer', stack: 'outer', cause: {
      message: 'alice@example.com Bearer abc123 https://user:pass@example.com/private/path?token=secret#fragment',
      stack: 'at https://user:pass@example.com/private/trace?token=secret#fragment',
    } });
    await instance.flush();
    const stack = events()[0].stack!;
    expect(stack).toContain('/masked/');
    expect(stack).toContain('[REDACTED_EMAIL]');
    expect(stack).toContain('Bearer [REDACTED]');
    expect(stack).not.toMatch(/user:pass|token=secret|fragment|alice@example.com|Bearer abc123|\/private\//);
    expect(hook).toHaveBeenCalled();
  });

  it('fails closed once if URL sanitization throws while adding a cause', async () => {
    const instance = create({ captureErrorCause: true, sanitizeUrl: url => {
      if (url.includes('/private/')) throw new Error('blocked');
      return url;
    } });
    instance.captureException({ message: 'outer', stack: 'trace', cause: { message: 'inner https://example.com/private/path?secret=1' } });
    await instance.flush();
    expect(events()).toHaveLength(0);
    expect(instance.getDiagnostics().droppedByReason.processingError).toBe(1);
  });

  it('lets beforeSend remove, edit or veto the complete stack even without the flag', async () => {
    const instance = create({ beforeSend: event => {
      if (event.message === 'delete') delete event.stack;
      if (event.message === 'undefined') event.stack = undefined;
      if (event.message === 'edit') event.stack = 'Bearer abc123';
      if (event.message === 'veto') return false;
      return event;
    } });
    for (const message of ['delete', 'undefined', 'edit', 'veto']) instance.captureException(new Error(message));
    await instance.flush();
    expect(events()).toHaveLength(3);
    expect(events()[0].stack).toBeUndefined();
    expect(events()[1].stack).toBeUndefined();
    expect(events()[2].stack).toBe('Bearer [REDACTED]');
    expect(instance.getDiagnostics().filtered).toBe(1);
  });

  it('does not treat an inner cause as seen or inspect network, abort, disabled or destroyed causes', async () => {
    const instance = create({ captureErrorCause: true, captureNetwork: true, endpoint: '/collector' });
    const inner = new Error('shared');
    instance.captureException(withCause('one', inner));
    instance.captureException(withCause('two', inner));
    const getter = vi.fn(() => inner);
    const failure = new Error('network');
    Object.defineProperty(failure, 'cause', { get: getter });
    (instance as unknown as { reportNetwork: (method: string, url: string, status: undefined, durationMs: number, failure: unknown) => void })
      .reportNetwork('GET', 'https://example.com/path', undefined, 1, failure);
    const abort = new Error('abort'); abort.name = 'AbortError';
    Object.defineProperty(abort, 'cause', { get: getter });
    instance.captureException(abort);
    const disabled = create({ enabled: false, captureErrorCause: true });
    disabled.captureException(failure);
    await instance.flush();
    expect(events().slice(0, 2).map(event => event.stack?.includes('Caused by: Error: shared'))).toEqual([true, true]);
    expect(getter).not.toHaveBeenCalled();
    instance.destroy();
    instance.captureException(failure);
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not read cause on the server', () => {
    const getter = vi.fn(() => new Error('inner'));
    const error = new Error('outer');
    Object.defineProperty(error, 'cause', { get: getter });
    vi.stubGlobal('window', undefined);
    const instance = create({ captureErrorCause: true });
    expect(() => instance.captureException(error)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
