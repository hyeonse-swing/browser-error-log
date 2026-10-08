import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  captureException: vi.fn(), flush: vi.fn(async () => {}),
  getStats: vi.fn(() => ({ sent: 1, queued: 0, dropped: 0 })), destroy: vi.fn(),
}));
vi.mock('browser-error-log', () => ({ init: vi.fn(() => client) }));

function chooseLanguage(value: string): void {
  const language = document.querySelector<HTMLSelectElement>('#language')!;
  language.value = value;
  language.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('collector connection example language', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = readFileSync('examples/micro-server/install.html', 'utf8');
  });
  afterEach(() => { document.body.innerHTML = ''; localStorage.clear(); });

  it('changes guidance and completed status without changing connection inputs or captured data', async () => {
    await import('./install');
    expect(document.documentElement.lang).toBe('en');
    expect(document.querySelector('h1')!.textContent).toBe('Connect the SDK');
    const endpoint = document.querySelector<HTMLInputElement>('#endpoint')!;
    const project = document.querySelector<HTMLInputElement>('#project')!;
    endpoint.value = 'https://logs.example/api/events';
    project.value = 'custom-app';
    project.dispatchEvent(new Event('input'));
    const snippet = document.querySelector('#snippet')!.textContent;
    document.querySelector<HTMLButtonElement>('#send')!.click();
    await vi.waitFor(() => expect(document.querySelector('#status')!.textContent).toContain('accepted one error'));

    chooseLanguage('ko');
    expect(document.documentElement.lang).toBe('ko');
    expect(document.querySelector('h1')!.textContent).toBe('SDK 연결');
    expect(document.querySelector('#status')!.textContent).toContain('오류 1건을 수신했습니다');
    expect(project.value).toBe('custom-app');
    expect(endpoint.value).toBe('https://logs.example/api/events');
    expect(document.querySelector('#snippet')!.textContent).toBe(snippet);
    expect(client.captureException.mock.calls[0][0].message).toBe('Micro server SDK example');
    expect(client.captureException).toHaveBeenCalledTimes(1);

    chooseLanguage('en');
    expect(document.querySelector('#status')!.textContent).toContain('accepted one error');
    expect(client.captureException).toHaveBeenCalledTimes(1);
  });

  it('uses the saved language on the log-only landing page without a form', async () => {
    localStorage.setItem('browser-error-log.language', 'ko');
    document.body.innerHTML = '<label><span data-i18n="language">Language</span><select id="language"><option value="en">English</option><option value="ko">한국어</option></select></label><p data-i18n="logOnly"></p>';
    await import('./install');
    expect(document.documentElement.lang).toBe('ko');
    expect(document.querySelector('p')!.textContent).toContain('JSONL 로그 전용 모드');
    chooseLanguage('en');
    expect(document.querySelector('p')!.textContent).toContain('JSONL log-only mode');
    expect(client.captureException).not.toHaveBeenCalled();
  });
});
