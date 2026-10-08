import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { init } from 'browser-error-log';
import type { EventBatch } from 'browser-error-log-protocol';
import { ErrorBoundary } from './index';

afterEach(() => { vi.restoreAllMocks(); });

it('records a rendering error and renders then resets the fallback', async () => {
  const batches: EventBatch[] = [];
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
      root.render(<ErrorBoundary client={client} fallback={(_error, reset) => <button onClick={reset}>retry</button>}><Child /></ErrorBoundary>);
    });
    expect(node.textContent).toBe('retry');
    await client.flush();
    expect(batches[0].events).toHaveLength(1);
    expect(batches[0].events[0]).toMatchObject({ type: 'react', message: 'render failed' });
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
