import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ErrorEventRecord } from 'browser-error-log-protocol';
import { App } from './App';
import { Dashboard } from './Dashboard';
import { eventDataSource } from './data-source';
import { loadHistory, type HistoryResult } from './history';
import { setLocale } from '../../i18n/locale';

vi.mock('./data-source', () => ({
  eventDataSource: { listEvents: vi.fn(), getEvent: vi.fn() },
  viewerConfig: { mode: 'local' },
}));
vi.mock('./history', async importOriginal => ({
  ...await importOriginal<typeof import('./history')>(),
  loadHistory: vi.fn(),
}));

function event(): ErrorEventRecord {
  return {
    schemaVersion: 1, eventId: 'old', project: 'web', environment: 'production', release: 'v1',
    sdkVersion: '0.1.0', occurredAt: '2026-10-02T00:00:00.000Z', viewId: 'view', sequence: 1,
    elapsedMs: 1, type: 'javascript', message: 'late old result', page: '/home', runtime: 'browser',
  };
}

function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('dashboard request lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setLocale('en');
    window.localStorage.clear();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(loadHistory).mockReset();
    vi.mocked(eventDataSource.listEvents).mockReset();
    vi.mocked(eventDataSource.getEvent).mockReset();
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
    setLocale('en');
  });

  it('keeps an invalid custom-range error after a previous request resolves late', async () => {
    let resolveOld!: (result: HistoryResult) => void;
    vi.mocked(loadHistory).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    await act(async () => { root.render(<Dashboard/>); });
    expect(loadHistory).toHaveBeenCalledTimes(1);
    const oldSignal = vi.mocked(loadHistory).mock.calls[0][2];

    const period = container.querySelectorAll<HTMLSelectElement>('.dash-filters select')[1];
    await act(async () => { changeValue(period, 'custom'); });
    const [from, to] = container.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');
    expect(from).toBeDefined();
    expect(to).toBeDefined();
    await act(async () => {
      changeValue(from, '2026-10-03T12:00');
      changeValue(to, '2026-10-02T12:00');
    });
    await act(async () => {
      container.querySelector<HTMLFormElement>('.dash-filters')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(oldSignal.aborted).toBe(true);
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The start cannot be later than the end');

    await act(async () => { resolveOld({ events: [event()], truncated: false, duplicates: 0 }); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The start cannot be later than the end');
    expect(container.querySelector('.dash-summary')).toBeNull();
    expect(container.querySelector('.chart-card')).toBeNull();
  });

  it('requests a fresh relative 24-hour window when opening the timeline later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    vi.mocked(loadHistory).mockResolvedValue({ events: [], truncated: false, duplicates: 0 });
    vi.mocked(eventDataSource.listEvents).mockResolvedValue({ events: [] });
    await act(async () => { root.render(<App/>); });
    expect(eventDataSource.listEvents).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-10-02T02:00:00.000Z'));
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('.side-navigation button')[1].click();
    });
    expect(eventDataSource.listEvents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(eventDataSource.listEvents).mock.calls[0][0]).toMatchObject({
      from: '2026-10-01T02:00:00.000Z', limit: 30,
    });
    expect(container.querySelector('.event-list')).not.toBeNull();
  });

  it('switches visible dashboard labels and counts without rerunning the query', async () => {
    vi.mocked(loadHistory).mockResolvedValue({ events: [event()], truncated: false, duplicates: 0 });
    vi.mocked(eventDataSource.listEvents).mockResolvedValue({ events: [event()] });
    vi.mocked(eventDataSource.getEvent).mockResolvedValue(event());
    await act(async () => { root.render(<App/>); });
    expect(container.querySelector('.dash-summary')?.textContent).toContain('1 event');
    expect(container.querySelector('h1')?.textContent).toBe('Error Dashboard');
    expect(container.querySelector('.chart-top-errors')?.textContent).toContain('late old result');
    expect(loadHistory).toHaveBeenCalledTimes(1);

    const project = container.querySelector<HTMLInputElement>('.dash-filters input[list="dash-projects"]')!;
    await act(async () => { changeValue(project, 'web'); });

    await act(async () => { changeValue(container.querySelector<HTMLSelectElement>('.language-switcher select')!, 'ko'); });
    expect(container.querySelector('h1')?.textContent).toBe('오류 대시보드');
    expect(container.querySelector('.dash-summary')?.textContent).toContain('1건');
    expect(document.documentElement.lang).toBe('ko');
    expect(document.title).toBe('브라우저 오류 기록');
    expect(project.value).toBe('web');
    expect(container.querySelector('.chart-top-errors')?.textContent).toContain('late old result');
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('browser-error-log.language')).toBe('ko');

    await act(async () => { container.querySelectorAll<HTMLButtonElement>('.side-navigation button')[1].click(); });
    expect(container.querySelector('.event-list')).not.toBeNull();
    expect(container.querySelector('.event-list')?.textContent).toContain('이벤트 목록');
  });

  it('translates an already-visible import error when the language changes', async () => {
    vi.mocked(loadHistory).mockRejectedValue(new Error('Import files cannot exceed 10 MiB.'));
    await act(async () => { root.render(<App/>); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Import files cannot exceed 10 MiB.');
    await act(async () => { changeValue(container.querySelector<HTMLSelectElement>('.language-switcher select')!, 'ko'); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('가져오기 파일은 10 MiB를 넘을 수 없습니다.');
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it('translates an already-visible timeline request error without refetching', async () => {
    vi.mocked(loadHistory).mockResolvedValue({ events: [], truncated: false, duplicates: 0 });
    vi.mocked(eventDataSource.listEvents).mockRejectedValue(new Error('Request failed. (HTTP 503)'));
    await act(async () => { root.render(<App/>); });
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('.side-navigation button')[1].click(); });
    expect(container.querySelector('.state-error')?.textContent).toContain('Request failed. (HTTP 503)');
    expect(eventDataSource.listEvents).toHaveBeenCalledTimes(1);
    await act(async () => { changeValue(container.querySelector<HTMLSelectElement>('.language-switcher select')!, 'ko'); });
    expect(container.querySelector('.state-error')?.textContent).toContain('요청에 실패했습니다. (HTTP 503)');
    expect(eventDataSource.listEvents).toHaveBeenCalledTimes(1);
  });
});
