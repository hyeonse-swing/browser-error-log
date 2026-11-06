import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@ihyeon/browser-error-log-protocol';
import { init, type BrowserErrorLogOptions, type BrowserErrorLogClient } from './index';

const clients: BrowserErrorLogClient[] = [];
const batches: EventBatch[] = [];
function client(options: Partial<BrowserErrorLogOptions> = {}) {
  const instance = init({ project: 'web', transport: batch => { batches.push(structuredClone(batch)); },
    captureNetwork: false, ...options });
  clients.push(instance);
  return instance;
}
function fail(element: HTMLElement) { element.dispatchEvent(new Event('error')); }
async function events(instance: BrowserErrorLogClient) {
  await instance.flush();
  return batches.flatMap(batch => batch.events);
}
beforeEach(() => { batches.length = 0; });
afterEach(() => {
  clients.splice(0).forEach(client => client.destroy());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('opt-in resource errors', () => {
  it('defaults off and adds a capture listener only for opted clients', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const off = client();
    expect(add.mock.calls.filter(([name, , capture]) => name === 'error' && capture === true)).toHaveLength(0);
    const on = client({ captureResourceErrors: true });
    expect(add.mock.calls.filter(([name, , capture]) => name === 'error' && capture === true)).toHaveLength(1);
    off.destroy(); on.destroy();
  });

  it.each(['script', 'link', 'img'] as const)('captures a %s resource through the shared event path', async tag => {
    const instance = client({ captureResourceErrors: true });
    const element = document.createElement(tag);
    if (element instanceof HTMLLinkElement) element.rel = 'alternate StyleSheet';
    if (element instanceof HTMLLinkElement) element.href = `https://user:pass@example.com/${tag}.js?token=secret#fragment`;
    else element.src = `https://user:pass@example.com/${tag}.js?token=secret#fragment`;
    element.setAttribute('alt', 'secret alt');
    document.body.append(element);
    fail(element);
    expect(await events(instance)).toMatchObject([{ type: 'resource', name: 'ResourceLoadError',
      message: `Failed to load ${tag} resource`, context: { resourceTag: tag, resourceUrl: `https://example.com/${tag}.js` } }]);
    expect(JSON.stringify(batches)).not.toMatch(/token=secret|user:pass|secret alt|fragment/);
  });

  it('uses currentSrc for responsive images and snapshots breadcrumbs', async () => {
    const instance = client({ captureResourceErrors: true });
    instance.addBreadcrumb({ message: 'before failure' });
    const img = document.createElement('img');
    img.src = 'https://example.com/fallback.png';
    Object.defineProperty(img, 'currentSrc', { value: 'https://example.com/selected.png?private=yes' });
    document.body.append(img); fail(img);
    expect(await events(instance)).toMatchObject([{ context: { resourceUrl: 'https://example.com/selected.png' },
      breadcrumbs: [{ message: 'before failure' }] }]);
  });

  it('ignores missing and explicitly empty URL attributes without inventing a page resource', async () => {
    const instance = client({ captureResourceErrors: true });
    for (const tag of ['script', 'link', 'img'] as const) {
      const element = document.createElement(tag);
      if (element instanceof HTMLLinkElement) element.rel = 'stylesheet';
      document.body.append(element);
      fail(element);
      element.setAttribute(tag === 'link' ? 'href' : 'src', '');
      fail(element);
      element.setAttribute(tag === 'link' ? 'href' : 'src', '  ');
      fail(element);
    }
    expect(await events(instance)).toHaveLength(0);
  });

  it('accepts a selected currentSrc without an src attribute', async () => {
    const instance = client({ captureResourceErrors: true });
    const img = document.createElement('img');
    img.srcset = 'https://example.com/selected.png 1x';
    Object.defineProperty(img, 'currentSrc', { value: 'https://example.com/selected.png?secret=yes' });
    document.body.append(img); fail(img);
    expect((await events(instance))[0].context?.resourceUrl).toBe('https://example.com/selected.png');
  });

  it('captures adopted HTML resources in the current document and ignores SVG namesakes', async () => {
    const instance = client({ captureResourceErrors: true });
    const frame = document.createElement('iframe'); document.body.append(frame);
    const foreign = frame.contentDocument!;
    for (const tag of ['script', 'link', 'img'] as const) {
      const element = foreign.createElement(tag);
      if (element instanceof foreign.defaultView!.HTMLLinkElement) element.rel = 'stylesheet';
      element.setAttribute(tag === 'link' ? 'href' : 'src', `https://example.com/${tag}`);
      document.body.append(document.adoptNode(element)); fail(element);
    }
    const fake = document.createElementNS('http://www.w3.org/2000/svg', 'img');
    fake.setAttribute('src', 'https://example.com/fake'); document.body.append(fake); fail(fake as unknown as HTMLElement);
    expect((await events(instance)).map(event => event.context?.resourceTag)).toEqual(['script', 'link', 'img']);
  });

  it('ignores unsupported, empty, unsafe and detached elements', async () => {
    const instance = client({ captureResourceErrors: true });
    const elements = [document.createElement('div'), document.createElement('link'),
      document.createElement('script'), document.createElement('img'), document.createElement('img'),
      document.createElement('img'), document.createElement('script')];
    elements[1].setAttribute('rel', 'icon'); (elements[1] as HTMLLinkElement).href = 'https://example.com/icon';
    (elements[3] as HTMLImageElement).src = 'data:image/png;base64,abcd';
    (elements[4] as HTMLImageElement).src = 'blob:https://example.com/id';
    (elements[5] as HTMLImageElement).src = 'javascript:alert(1)';
    (elements[6] as HTMLScriptElement).src = 'https://example.com/detached.js';
    elements.slice(0, -1).forEach(element => document.body.append(element));
    elements.forEach(fail);
    expect(await events(instance)).toHaveLength(0);
  });

  it('ignores collector URLs independently of network capture and custom transport', async () => {
    const instance = client({ captureResourceErrors: true, endpoint: 'https://example.com/collect?key=private' });
    const img = document.createElement('img'); img.src = 'https://example.com/collect?anything=1';
    document.body.append(img); fail(img);
    expect(await events(instance)).toHaveLength(0);
  });

  it('safely skips a throwing URL getter and never replays earlier failures', async () => {
    const img = document.createElement('img');
    img.src = 'https://example.com/a.png'; document.body.append(img);
    fail(img);
    const instance = client({ captureResourceErrors: true });
    expect(instance.getStats().queued).toBe(0);
    Object.defineProperty(img, 'currentSrc', { get() { throw new Error('hostile getter'); } });
    Object.defineProperty(img, 'src', { get() { throw new Error('hostile getter'); } });
    expect(() => fail(img)).not.toThrow();
    expect(await events(instance)).toHaveLength(0);
  });

  it('keeps global JavaScript errors once and ignores bubbling element errors', async () => {
    const instance = client({ captureResourceErrors: true });
    const error = new ErrorEvent('error', { message: 'boom', filename: 'https://example.com/app.js' });
    window.dispatchEvent(error);
    expect(error.target instanceof Window).toBe(true);
    expect(instance.getStats().queued).toBe(1);
    const img = document.createElement('img'); img.src = 'https://example.com/a.png'; document.body.append(img);
    img.dispatchEvent(new Event('error', { bubbles: true }));
    expect((await events(instance)).map(event => event.type)).toEqual(['javascript', 'resource']);
  });

  it('reports each retry once without changing native handlers or default prevention', async () => {
    const instance = client({ captureResourceErrors: true });
    const img = document.createElement('img'); img.src = 'https://example.com/a.png'; document.body.append(img);
    const native = vi.fn(); img.onerror = native;
    const first = new Event('error', { cancelable: true });
    expect(img.dispatchEvent(first)).toBe(true); fail(img);
    expect(native).toHaveBeenCalledTimes(2);
    expect(first.defaultPrevented).toBe(false);
    expect(await events(instance)).toHaveLength(2);
  });

  it('fails closed once for sanitizer, context and beforeSend failures', async () => {
    for (const options of [
      { sanitizeUrl: () => { throw new Error('failed'); } },
      { sanitizeUrl: () => 'javascript:bad' },
      { getContext: () => { throw new Error('failed'); } },
      { beforeSend: () => { throw new Error('failed'); } },
    ] satisfies Partial<BrowserErrorLogOptions>[]) {
      const instance = client({ captureResourceErrors: true, ...options });
      const img = document.createElement('img'); img.src = 'https://example.com/a.png'; document.body.append(img);
      fail(img); await instance.flush();
      expect(instance.getDiagnostics().droppedByReason.processingError).toBe(1);
      expect(instance.getStats().queued).toBe(0);
      instance.destroy(); img.remove();
    }
    expect(batches).toHaveLength(0);
  });

  it('passes through beforeSend veto and shared rate limit', async () => {
    const filtered = client({ captureResourceErrors: true, beforeSend: () => false });
    const img = document.createElement('img'); img.src = 'https://example.com/a.png'; document.body.append(img);
    fail(img); expect(filtered.getDiagnostics().filtered).toBe(1); filtered.destroy();
    const limited = client({ captureResourceErrors: true, maxEventsPerMinute: 1 });
    limited.captureException('first'); fail(img);
    expect((await events(limited)).map(event => event.type)).toEqual(['manual']);
    expect(limited.getDiagnostics().droppedByReason.rateLimit).toBe(1);
  });

  it('keeps resource context ahead of dynamic and default context', async () => {
    const instance = client({ captureResourceErrors: true,
      context: { resourceTag: 'wrong', defaultValue: 1 },
      getContext: () => ({ resourceUrl: 'wrong', dynamicValue: 2 }) });
    const img = document.createElement('img'); img.src = 'https://example.com/a.png'; document.body.append(img); fail(img);
    expect((await events(instance))[0].context).toMatchObject({ resourceTag: 'img',
      resourceUrl: 'https://example.com/a.png', defaultValue: 1, dynamicValue: 2 });
  });

  it('snapshots the option per client and unregisters on destroy', async () => {
    const options: BrowserErrorLogOptions = { project: 'web', transport: batch => { batches.push(batch); },
      captureNetwork: false, captureResourceErrors: true };
    const first = client(options); options.captureResourceErrors = false;
    const second = client(options);
    const img = document.createElement('img'); img.src = 'https://example.com/a.png'; document.body.append(img); fail(img);
    expect(first.getStats().queued).toBe(1); expect(second.getStats().queued).toBe(0);
    first.destroy(); fail(img); expect(first.getStats().queued).toBe(0);
  });

  it('does nothing while disabled or under SSR', () => {
    const disabled = client({ enabled: false, captureResourceErrors: true });
    vi.stubGlobal('window', undefined);
    const server = client({ captureResourceErrors: true });
    expect(disabled.getStats().queued).toBe(0);
    expect(server.getStats().queued).toBe(0);
  });
});
