import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setLocale } from '../../i18n/locale';
import { BreadcrumbTrail } from './BreadcrumbTrail';

const earlier = { occurredAt: '2026-10-02T01:00:00.000Z', category: 'navigation', message: 'Opened /checkout' };
const later = { occurredAt: '2026-10-02T01:01:00.000Z', category: 'ui', message: 'Clicked pay', data: { attempt: 2, success: false, token: null } };

describe('BreadcrumbTrail', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    setLocale('en');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    setLocale('en');
  });

  it('keeps recording order when the clock moves backward, with local time and scalar details', async () => {
    await act(async () => { root.render(<BreadcrumbTrail breadcrumbs={[later, earlier]}/>); });
    expect(container.textContent).toContain('Activity before this error');
    expect(container.textContent).toContain('Recorded steps, oldest first');
    expect([...container.querySelectorAll('.breadcrumb-entry .breadcrumb-message')].map(node => node.textContent))
      .toEqual(['Clicked pay', 'Opened /checkout']);
    const times = [...container.querySelectorAll('time')];
    expect(times.map(node => node.getAttribute('dateTime'))).toEqual([later.occurredAt, earlier.occurredAt]);
    expect(times[0].textContent).toBe(new Date(later.occurredAt).toLocaleString('en-US', { hour12: false }));
    expect(container.querySelector('details')?.textContent).toContain('attempt');
    expect(container.querySelector('details')?.textContent).toContain('false');
    expect(container.querySelector('details')?.textContent).toContain('null');
  });

  it('updates labels and time locale in Korean', async () => {
    await act(async () => { root.render(<BreadcrumbTrail breadcrumbs={[earlier]}/>); });
    await act(async () => { setLocale('ko'); });
    expect(container.textContent).toContain('오류 전 작업 기록');
    expect(container.textContent).toContain('작업 기록 · 오래된 순');
    expect(container.querySelector('time')?.textContent).toBe(new Date(earlier.occurredAt).toLocaleString('ko-KR', { hour12: false }));
  });

  it('renders nothing for missing, empty, or invalid trails', async () => {
    for (const breadcrumbs of [undefined, [], [{ ...earlier, occurredAt: 'invalid' }], [{ ...earlier, data: { nested: { secret: true } } }]]) {
      await act(async () => { root.render(<BreadcrumbTrail breadcrumbs={breadcrumbs}/>); });
      expect(container.innerHTML).toBe('');
    }
  });

  it('keeps supplied text inert and long messages in a bounded list', async () => {
    const message = `<img src=x onerror=alert(1)>${'x'.repeat(200)}`;
    await act(async () => { root.render(<BreadcrumbTrail breadcrumbs={[{ ...earlier, message, data: { note: '<script>alert(1)</script>' } }]}/>); });
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.querySelector('.breadcrumb-message')?.textContent).toBe(message);
    expect(container.querySelector('.breadcrumb-list')).not.toBeNull();
  });

  it('shows HTTP and network summaries without opening details, with localized unavailable status', async () => {
    const http = { ...earlier, category: 'http', message: 'HTTP response', data: { method: 'POST', url: '/orders', status: 503, durationMs: 12.5 } };
    const network = { ...later, category: 'network', message: 'Network failure', data: { method: 'GET', url: '/orders', status: 0, durationMs: 0 } };
    await act(async () => { root.render(<BreadcrumbTrail breadcrumbs={[http, network]}/>); });
    const summaries = [...container.querySelectorAll('.breadcrumb-network-summary')];
    expect(summaries.map(node => node.textContent)).toEqual(['POST /orders · 503 · 12.5 ms', 'GET /orders · Status unavailable · 0 ms']);
    expect(container.querySelectorAll('details:not([open])')).toHaveLength(2);
    await act(async () => { setLocale('ko'); });
    expect(container.querySelectorAll('.breadcrumb-network-summary')[1]?.textContent).toBe('GET /orders · 상태 확인 불가 · 0 ms');
    await act(async () => { root.render(<BreadcrumbTrail breadcrumbs={[{ ...network, data: { method: 'GET', url: '/orders', durationMs: 0 } }]}/>); });
    expect(container.querySelector('.breadcrumb-network-summary')?.textContent).toBe('GET /orders · 상태 확인 불가 · 0 ms');
  });

  it('does not invent network fields for missing or invalid scalar metadata', async () => {
    const entries = [
      { ...earlier, category: 'http', data: { method: 7, url: '/orders', durationMs: 1 } },
      { ...later, category: 'network', data: { method: 'GET', durationMs: 2 } },
      { ...earlier, category: 'http', data: { method: 'GET', url: '/valid', status: -1, durationMs: -4 } },
      { ...later, category: 'navigation', data: { method: 'GET', url: '/not-network', status: 200, durationMs: 3 } },
    ];
    await act(async () => { root.render(<BreadcrumbTrail breadcrumbs={entries}/>); });
    expect([...container.querySelectorAll('.breadcrumb-network-summary')].map(node => node.textContent)).toEqual(['GET /valid · Status unavailable']);
    expect(container.querySelectorAll('.breadcrumb-data')).toHaveLength(4);
  });

  it('renders URL text without creating markup or links', async () => {
    const url = '<script>alert(1)</script><a href="https://example.com">visit</a>';
    await act(async () => { root.render(<BreadcrumbTrail breadcrumbs={[{ ...earlier, category: 'http', data: { method: 'GET', url, status: 200, durationMs: 1 } }]}/>); });
    expect(container.querySelector('.breadcrumb-network-summary')?.textContent).toContain(url);
    expect(container.querySelector('script, a')).toBeNull();
  });
});
