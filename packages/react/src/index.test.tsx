import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { init } from '@ihyeon/browser-error-log';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { ErrorBoundary } from './index';

afterEach(() => { vi.restoreAllMocks(); });

it('shows only the current capture reference after retrying, without an onCapture handler', async () => {
  const batches: EventBatch[] = [];
  const client = init({ project: 'support', transport: batch => { batches.push(batch); } });
  const rootNode = document.createElement('div');
  const root = createRoot(rootNode);
  let message = 'A';
  const rendered: { message: string; eventId?: string }[] = [];
  function Child(): React.ReactNode { throw new Error(message); }
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => {
      root.render(<ErrorBoundary client={client} fallback={(error, reset, reference) => {
        rendered.push({ message: error.message, eventId: reference?.eventId });
        return <button onClick={reset}>{reference?.eventId}</button>;
      }}><Child /></ErrorBoundary>);
    });
    const first = rootNode.textContent;
    expect(first).toBeTruthy();
    message = 'B';
    await act(async () => { rootNode.querySelector('button')!.click(); });
    const second = rootNode.textContent;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(rendered.some(frame => frame.message === 'B' && frame.eventId === first)).toBe(false);
    await client.flush();
    expect(batches.flatMap(batch => batch.events).map(event => event.eventId)).toEqual([first, second]);
  } finally {
    await act(async () => { root.unmount(); });
    client.destroy();
  }
});

it.each([null, undefined, false, 0, '', 'render failed', { toString() { throw new Error('unreadable'); } }])(
  'keeps the fallback usable for a non-Error throw (case %#)', async (thrown) => {
    const captureException = vi.fn();
    const onCapture = vi.fn();
    const client = { captureException, flush: async () => {}, destroy: () => {}, getStats: () => ({ queued: 0, sent: 0, dropped: 0 }) };
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    let shouldThrow = true;
    function Child() { if (shouldThrow) throw thrown; return <span>healthy</span>; }
    const fallback = vi.fn((error: Error, reset: () => void) => <button onClick={reset}>{error.message || 'retry'}</button>);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => { root.render(<ErrorBoundary client={client} onCapture={onCapture} fallback={fallback}><Child /></ErrorBoundary>); });
      expect(node.querySelector('button')).not.toBeNull();
      expect(fallback.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(captureException).toHaveBeenCalledWith(thrown, expect.objectContaining({ type: 'react' }));
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(onCapture).not.toHaveBeenCalled();
      shouldThrow = false;
      await act(async () => { node.querySelector('button')!.click(); });
      expect(node.textContent).toBe('healthy');
    } finally {
      await act(async () => { root.unmount(); });
      node.remove();
    }
  },
);

it('records a rendering error and renders then resets the fallback', async () => {
  const batches: EventBatch[] = [];
  const onCapture = vi.fn(() => { throw new Error('consumer callback failed'); });
  const client = init({
    project: 'react-app',
    transport: batch => { batches.push(batch); },
    captureNetwork: false,
  });
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  let shouldThrow = true;
  function Child() {
    if (shouldThrow) throw new Error('render failed');
    return <span>healthy</span>;
  }
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => {
      root.render(<ErrorBoundary client={client} onCapture={onCapture} fallback={(_error, reset) => <button onClick={reset}>retry</button>}><Child /></ErrorBoundary>);
    });
    expect(node.textContent).toBe('retry');
    await client.flush();
    expect(batches[0].events).toHaveLength(1);
    expect(batches[0].events[0]).toMatchObject({ type: 'react', message: 'render failed' });
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledWith({ project: 'react-app', eventId: batches[0].events[0].eventId });
    expect(batches[0].events[0].componentStack).toContain('Child');

    shouldThrow = false;
    await act(async () => { node.querySelector('button')!.click(); });
    expect(node.textContent).toBe('healthy');
  } finally {
    await act(async () => { root.unmount(); });
    node.remove();
    client.destroy();
  }
});
