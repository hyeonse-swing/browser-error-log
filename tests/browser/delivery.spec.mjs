import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

let scratch;
let collector;
let origin;

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function events(environment) {
  const response = await fetch(`${origin}/api/events?project=browser-test&environment=${environment}`);
  expect(response.ok, `Collector query returned HTTP ${response.status}`).toBe(true);
  return (await response.json()).events;
}

async function init(page, environment, captureAllHttp = false) {
  await page.goto(`${origin}/?token=synthetic-page-secret`);
  await page.evaluate(async ({ environment, captureAllHttp }) => {
    const { init } = await import('/sdk.js');
    window.testClient = init({
      project: 'browser-test', environment, endpoint: '/api/events',
      flushIntervalMs: 50,
      ...(captureAllHttp ? { shouldCaptureHttp: () => true } : {}),
    });
  }, { environment, captureAllHttp });
}

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'browser-delivery-'));
  const publicDir = join(scratch, 'public');
  await mkdir(publicDir);
  await copyFile('packages/browser/dist/index.js', join(publicDir, 'sdk.js'));
  await copyFile('dist/viewer/index.html', join(publicDir, 'viewer.html'));
  await cp('dist/viewer/assets', join(publicDir, 'assets'), { recursive: true });
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>SDK browser delivery test</title>');
  await writeFile(join(publicDir, 'source-location.js'), "throw 'synthetic source failure';\n");
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MICRO_')));
  collector = spawn(process.execPath, [resolve('dist/micro-server/server.mjs')], {
    env: { ...env, MICRO_HOST: '127.0.0.1', MICRO_PORT: String(port),
      MICRO_PROJECTS: 'browser-test', MICRO_STORAGE: 'sqlite',
      MICRO_REQUESTS_PER_MINUTE: '1000', // This suite exercises delivery; server rate limits have dedicated tests.
      MICRO_PUBLIC_DIR: publicDir, MICRO_DATA_DIR: join(scratch, 'data') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  collector.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (collector.exitCode !== null) throw new Error(`Collector exited: ${diagnostics}`);
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { /* waiting for listener */ }
    await delay(100);
  }
  throw new Error(`Collector did not start: ${diagnostics}`);
});

test.afterAll(async () => {
  if (collector && collector.exitCode === null && collector.signalCode === null) {
    const closed = once(collector, 'exit');
    collector.kill('SIGTERM');
    const timeout = setTimeout(() => collector.kill('SIGKILL'), 10_000);
    try { await closed; } finally { clearTimeout(timeout); }
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test('delivers a queued error on native pagehide without the visibility handler', async ({ page }) => {
  const environment = randomUUID();
  await page.goto(`${origin}/`);
  const pending = await page.evaluate(async environment => {
    const { init } = await import('/sdk.js');
    // Isolate the fallback while leaving the browser's native navigation events intact.
    document.addEventListener('visibilitychange', event => event.stopImmediatePropagation(), true);
    const captured = [];
    window.testClient = init({ project: 'browser-test', environment, endpoint: '/api/events',
      captureNetwork: false, flushIntervalMs: 60_000,
      beforeSend: event => { captured.push({ eventId: event.eventId, message: event.message }); } });
    window.testClient.captureException('leaving this document');
    return { captured, stats: window.testClient.getStats() };
  }, environment);
  expect(pending.stats).toEqual({ queued: 1, sent: 0, dropped: 0 });
  expect(await events(environment)).toHaveLength(0);

  await page.goto(`${origin}/?after-pagehide=1`);
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  const stored = await events(environment);
  expect(stored.map(event => ({ eventId: event.eventId, message: event.message }))).toEqual(pending.captured);
});

test('holds queued errors offline and delivers the same events automatically on reconnect', async ({ page, context }) => {
  const environment = randomUUID();
  const collectorBodies = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/events') {
      collectorBodies.push(request.postDataJSON());
    }
  });
  await page.goto(`${origin}/`);
  await page.evaluate(async environment => {
    const { init } = await import('/sdk.js');
    window.onlineTransitions = [];
    window.addEventListener('offline', () => window.onlineTransitions.push('offline'));
    window.addEventListener('online', () => window.onlineTransitions.push('online'));
    window.pendingEvents = [];
    window.testClient = init({ project: 'browser-test', environment, endpoint: '/api/events',
      captureNetwork: false, pauseWhileOffline: true, flushIntervalMs: 60_000,
      beforeSend: event => {
        window.pendingEvents.push({ eventId: event.eventId, message: event.message });
        return event;
      } });
  }, environment);

  try {
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    const offline = await page.evaluate(async () => {
      window.testClient.captureException(new Error('offline first'),
        { context: { phase: 'first', password: 'hide-me' } });
      window.testClient.captureException(new Error('offline second'), { context: { phase: 'second' } });
      const beforeFlush = window.testClient.getStats();
      await window.testClient.flush();
      return { beforeFlush, afterFlush: window.testClient.getStats(),
        pending: [...window.pendingEvents], transitions: [...window.onlineTransitions] };
    });
    expect(offline.beforeFlush).toEqual({ queued: 2, sent: 0, dropped: 0 });
    expect(offline.afterFlush).toEqual(offline.beforeFlush);
    expect(offline.pending.map(event => event.message)).toEqual(['offline first', 'offline second']);
    expect(new Set(offline.pending.map(event => event.eventId)).size).toBe(2);
    expect(offline.transitions).toContain('offline');
    expect(collectorBodies).toHaveLength(0);
    expect(await events(environment)).toHaveLength(0);

    await context.setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    await expect.poll(async () => (await events(environment)).length).toBe(2);
    const stored = await events(environment);
    const byId = (a, b) => a.eventId.localeCompare(b.eventId);
    expect(stored.map(event => ({ eventId: event.eventId, message: event.message,
      phase: event.context.phase })).sort(byId))
      .toEqual(offline.pending.map((event, index) => ({ ...event,
        phase: index === 0 ? 'first' : 'second' })).sort(byId));
    await expect.poll(() => page.evaluate(() => window.testClient.getStats()))
      .toEqual({ queued: 0, sent: 2, dropped: 0 });
    expect(await page.evaluate(() => window.onlineTransitions)).toContain('online');
    expect(collectorBodies).toHaveLength(1);
    expect(collectorBodies[0].events.map(event => event.eventId))
      .toEqual(offline.pending.map(event => event.eventId));
    expect(Object.keys(collectorBodies[0]).sort()).toEqual(['events', 'schemaVersion']);
    expect(JSON.stringify(collectorBodies)).not.toMatch(/pauseWhileOffline|hide-me/);
  } finally {
    await context.setOffline(false);
    await page.evaluate(() => window.testClient?.destroy());
  }
});

test('deduplicates fresh equivalent errors across flushes only when enabled', async ({ page }) => {
  const environment = randomUUID();
  const defaultEnvironment = randomUUID();
  const collectorBodies = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/events') {
      collectorBodies.push(request.postDataJSON());
    }
  });
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async ({ environment, defaultEnvironment }) => {
    const { init } = await import('/sdk.js');
    const freshError = () => {
      const error = new Error('duplicate failure');
      error.stack = 'Error: duplicate failure\n    at fixedFrame (bundle.js:1:1)';
      return error;
    };
    const client = init({ project: 'browser-test', environment, endpoint: '/api/events',
      captureNetwork: false, dedupeIntervalMs: 60_000,
      flushIntervalMs: 60_000 });
    client.captureException(freshError(), { context: { phase: 'same' } });
    client.captureException(freshError(), { context: { phase: 'same' } });
    const afterDuplicate = client.getDiagnostics();
    client.captureException(freshError(), { context: { phase: 'different' } });
    const beforeFlush = client.getDiagnostics();
    await client.flush();
    const afterFlush = client.getDiagnostics();
    client.captureException(freshError(), { context: { phase: 'same' } });
    await client.flush();
    const afterRepeat = client.getDiagnostics();
    const stats = client.getStats();
    client.destroy();

    const defaultClient = init({ project: 'browser-test', environment: defaultEnvironment,
      endpoint: '/api/events', captureNetwork: false, flushIntervalMs: 60_000 });
    defaultClient.captureException(freshError());
    defaultClient.captureException(freshError());
    await defaultClient.flush();
    const defaultStats = defaultClient.getStats();
    const defaultDiagnostics = defaultClient.getDiagnostics();
    defaultClient.destroy();
    return { afterDuplicate, beforeFlush, afterFlush, afterRepeat, stats,
      defaultStats, defaultDiagnostics };
  }, { environment, defaultEnvironment });

  expect(result.afterDuplicate).toMatchObject({ queued: 1, sent: 0, dropped: 0, deduplicated: 1 });
  expect(result.beforeFlush).toMatchObject({ queued: 2, sent: 0, dropped: 0, deduplicated: 1 });
  expect(result.afterFlush).toMatchObject({ queued: 0, sent: 2, dropped: 0, deduplicated: 1 });
  expect(result.afterRepeat).toMatchObject({ queued: 0, sent: 2, dropped: 0, deduplicated: 2 });
  expect(result.stats).toEqual({ queued: 0, sent: 2, dropped: 0 });
  expect(result.defaultStats).toEqual({ queued: 0, sent: 2, dropped: 0 });
  expect(result.defaultDiagnostics).toMatchObject({ queued: 0, sent: 2, dropped: 0, deduplicated: 0 });
  expect(collectorBodies).toHaveLength(2);
  expect(collectorBodies.every(batch => batch.schemaVersion === 1)).toBe(true);
  const wire = collectorBodies.flatMap(batch => batch.events);
  expect(wire).toHaveLength(4);
  expect(new Set(wire.map(event => event.eventId)).size).toBe(4);
  expect(wire.filter(event => event.environment === environment).map(event => event.context.phase).sort()).toEqual(['different', 'same']);
  expect(wire.filter(event => event.environment === defaultEnvironment)).toHaveLength(2);
  expect(JSON.stringify(collectorBodies)).not.toMatch(/dedupeIntervalMs|deduplicated|fingerprint/);
  await expect.poll(async () => (await events(environment)).length).toBe(2);
  await expect.poll(async () => (await events(defaultEnvironment)).length).toBe(2);
  expect((await events(environment)).map(event => event.context.phase).sort()).toEqual(['different', 'same']);
});

test('filters and sanitizes breadcrumbs at creation without changing error delivery', async ({ page }) => {
  const environment = randomUUID();
  const collectorBodies = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/events') {
      collectorBodies.push(request.postDataJSON());
    }
  });
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async environment => {
    const { init } = await import('/sdk.js');
    const hookCalls = [];
    const client = init({ project: 'browser-test', environment, endpoint: '/api/events',
      captureNavigation: true, captureNetworkBreadcrumbs: true, captureNetwork: false,
      flushIntervalMs: 60_000, beforeBreadcrumb: breadcrumb => {
        hookCalls.push(`${breadcrumb.category}:${breadcrumb.message}`);
        if (breadcrumb.message === 'Draft filtered step') return false;
        if (breadcrumb.category === 'http' && breadcrumb.data?.url.endsWith('/api/health')) return null;
        if (breadcrumb.message === 'Checkout click') {
          breadcrumb.message = 'Checkout confirmed';
          breadcrumb.occurredAt = '2000-01-01T00:00:00.000Z';
          breadcrumb.data = { ...breadcrumb.data, route: '/checkout?token=manual-secret#fragment',
            email: 'learner@example.test', authorization: 'Bearer authorization-secret',
            note: 'Bearer note-secret' };
          breadcrumb.privateExtra = 'unrecognized-secret';
        }
      } });
    client.addBreadcrumb({ category: 'manual', message: 'Draft filtered step',
      data: { note: 'filtered-step-secret' } });
    client.addBreadcrumb({ category: 'manual', message: 'Checkout click', data: { amount: 1 } });
    history.pushState({ privateState: 'history-state-secret' }, '', '/checkout?token=history-secret#fragment');
    const response = await fetch('/api/health?token=http-secret');
    const responseStatus = response.status;
    client.captureException(new Error('breadcrumb hook failure'));
    const callsAtCapture = [...hookCalls];
    await client.flush();
    const stats = client.getStats();
    client.destroy();
    return { hookCalls, callsAtCapture, responseStatus, stats };
  }, environment);

  const expectedCalls = ['manual:Draft filtered step', 'manual:Checkout click',
    'navigation:Navigation', 'http:HTTP response'];
  expect(result).toEqual({ hookCalls: expectedCalls, callsAtCapture: expectedCalls,
    responseStatus: 200, stats: { queued: 0, sent: 1, dropped: 0 } });
  expect(collectorBodies).toHaveLength(1);
  expect(collectorBodies[0]).toMatchObject({ schemaVersion: 1, events: [
    { type: 'manual', message: 'breadcrumb hook failure' },
  ] });
  const wire = collectorBodies[0].events[0];
  expect(wire.breadcrumbs).toHaveLength(2);
  expect(wire.breadcrumbs[0]).toMatchObject({ category: 'manual', message: 'Checkout confirmed',
    data: { amount: 1, route: '/checkout', email: '[REDACTED_EMAIL]', note: 'Bearer [REDACTED]' } });
  expect(Object.keys(wire.breadcrumbs[0]).sort()).toEqual(['category', 'data', 'message', 'occurredAt']);
  expect(Object.keys(wire.breadcrumbs[0].data).sort()).toEqual(['amount', 'email', 'note', 'route']);
  expect(wire.breadcrumbs[0].occurredAt).not.toBe('2000-01-01T00:00:00.000Z');
  expect(wire.breadcrumbs[1]).toMatchObject({ category: 'navigation', message: 'Navigation',
    data: { from: `${origin}/`, to: `${origin}/checkout`, trigger: 'pushState' } });
  expect(JSON.stringify(collectorBodies)).not.toMatch(/Draft filtered step|filtered-step-secret|manual-secret|history-secret|history-state-secret|http-secret|learner@example.test|authorization-secret|note-secret|unrecognized-secret|api\/health/);
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  const [stored] = await events(environment);
  expect(stored.breadcrumbs).toEqual(wire.breadcrumbs);
});

test('opt-in resource load failures reach the collector and viewer without DOM details', async ({ page }) => {
  const defaultEnvironment = randomUUID();
  const environment = randomUUID();
  const collectorBodies = [];
  const resourceRequests = [];
  const resourceResponses = [];
  const failedResourceRequests = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/missing-resource-')) resourceRequests.push(pathname);
    if (request.method() === 'POST' && pathname === '/api/events') {
      collectorBodies.push(request.postDataJSON());
    }
  });
  page.on('requestfailed', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/missing-resource-')) failedResourceRequests.push(pathname);
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/missing-resource-')) {
      resourceResponses.push([new URL(response.url()).pathname, response.status()]);
    }
  });
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async ({ defaultEnvironment, environment }) => {
    const { init } = await import('/sdk.js');
    const nativeErrors = [];
    const loadMissing = (tag, path) => new Promise((resolve, reject) => {
      const element = document.createElement(tag);
      element.addEventListener('error', () => { nativeErrors.push(tag); resolve(); }, { once: true });
      element.addEventListener('load', () => reject(new Error(`${tag} unexpectedly loaded`)), { once: true });
      if (tag === 'link') { element.rel = 'stylesheet'; element.href = path; document.head.append(element); }
      else if (tag === 'script') { element.src = path; document.head.append(element); }
      else {
        element.alt = 'private-alt-secret';
        element.id = 'private-id-secret';
        element.src = path;
        document.body.append(element);
      }
    });
    const defaultClient = init({ project: 'browser-test', environment: defaultEnvironment,
      endpoint: '/api/events', captureNetwork: false, flushIntervalMs: 60_000 });
    await loadMissing('img', '/missing-resource-default.png?token=default-secret#default-fragment');
    await defaultClient.flush();
    const defaultStats = defaultClient.getStats();
    defaultClient.destroy();

    const client = init({ project: 'browser-test', environment, endpoint: '/api/events',
      captureNetwork: false, captureResourceErrors: true, flushIntervalMs: 60_000 });
    await Promise.all([
      loadMissing('script', '/missing-resource-script.js?token=resource-secret#private-fragment'),
      loadMissing('link', '/missing-resource-link.css?token=resource-secret#private-fragment'),
      loadMissing('img', '/missing-resource-img.png?token=resource-secret#private-fragment'),
    ]);
    const emptyImage = document.createElement('img');
    emptyImage.setAttribute('src', '');
    document.body.append(emptyImage);
    emptyImage.dispatchEvent(new Event('error'));
    await client.flush();
    const stats = client.getStats();
    client.destroy();
    return { defaultStats, stats, nativeErrors: nativeErrors.sort() };
  }, { defaultEnvironment, environment });

  expect(result).toEqual({ defaultStats: { queued: 0, sent: 0, dropped: 0 },
    stats: { queued: 0, sent: 3, dropped: 0 }, nativeErrors: ['img', 'img', 'link', 'script'] });
  expect(resourceRequests.sort()).toEqual([
    '/missing-resource-default.png', '/missing-resource-img.png',
    '/missing-resource-link.css', '/missing-resource-script.js',
  ]);
  expect(resourceResponses.every(([, status]) => status === 404)).toBe(true);
  expect(resourceResponses.filter(([path]) => path !== '/missing-resource-link.css').sort()).toEqual([
    ['/missing-resource-default.png', 404], ['/missing-resource-img.png', 404],
    ['/missing-resource-script.js', 404],
  ]);
  expect(resourceResponses.some(([path]) => path === '/missing-resource-link.css') ||
    failedResourceRequests.includes('/missing-resource-link.css')).toBe(true);
  expect((await fetch(`${origin}/missing-resource-link.css?token=fixture-secret`)).status).toBe(404);
  expect(collectorBodies).toHaveLength(1);
  expect(collectorBodies[0]).toMatchObject({ schemaVersion: 1, events: expect.any(Array) });
  const wireEvents = collectorBodies[0].events;
  expect(wireEvents).toHaveLength(3);
  for (const [tag, extension] of [['script', 'js'], ['link', 'css'], ['img', 'png']]) {
    const event = wireEvents.find(item => item.context?.resourceTag === tag);
    expect(event).toMatchObject({ type: 'resource', name: 'ResourceLoadError',
      message: `Failed to load ${tag} resource`,
      context: { resourceTag: tag, resourceUrl: `${origin}/missing-resource-${tag}.${extension}` } });
    expect(Object.keys(event.context).sort()).toEqual(['resourceTag', 'resourceUrl']);
    for (const field of ['stack', 'network', 'status', 'durationMs']) expect(event).not.toHaveProperty(field);
  }
  expect(JSON.stringify(collectorBodies)).not.toMatch(/resource-secret|private-fragment|private-alt-secret|private-id-secret|default-secret|default-fragment/);
  expect(await events(defaultEnvironment)).toHaveLength(0);
  await expect.poll(async () => (await events(environment)).length).toBe(3);
  const stored = await events(environment);
  expect(stored.map(event => event.type)).toEqual(['resource', 'resource', 'resource']);
  for (const event of wireEvents) expect(stored.find(item => item.eventId === event.eventId)).toMatchObject(event);
  const filteredResponse = await fetch(`${origin}/api/events?project=browser-test&environment=${environment}&type=resource`);
  expect(filteredResponse.ok).toBe(true);
  expect((await filteredResponse.json()).events).toHaveLength(3);

  await page.goto(`${origin}/viewer.html`);
  await page.locator('.language-switcher select').selectOption('en');
  await page.locator('.dash-filters').getByLabel('Environment', { exact: true }).fill(environment);
  await page.locator('.dash-filters').getByLabel('Error types').selectOption('resource');
  await expect(page.locator('.dash-filters select option:checked').first()).toHaveText('Resource failure');
  await page.locator('.dash-filters').getByRole('button', { name: /Query/ }).click();
  await expect(page.locator('.dash-summary')).toContainText('3 events');
  await page.locator('.language-switcher select').selectOption('ko');
  await expect(page.locator('.dash-filters').getByLabel('오류 유형')).toHaveValue('resource');
  await expect(page.locator('.dash-filters select option:checked').first()).toHaveText('리소스 로딩 실패');
  await page.locator('.language-switcher select').selectOption('en');
  await page.getByRole('button', { name: 'Event Timeline', exact: true }).last().click();
  await page.getByLabel('Environment', { exact: true }).last().fill(environment);
  await page.getByLabel('Type', { exact: true }).last().selectOption('resource');
  await expect(page.locator('.event-row')).toHaveCount(3);
  await page.locator('.event-row').filter({ hasText: 'Failed to load script resource' }).click();
  const inspector = page.locator('.detail-panel');
  await expect(inspector).toContainText('resourceTag');
  await expect(inspector).toContainText(`${origin}/missing-resource-script.js`);
});

test('captures a resource element adopted from another browser realm', async ({ page }) => {
  const environment = randomUUID();
  const collectorBodies = [];
  const resourceRequests = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/missing-resource-adopted.png') resourceRequests.push(path);
    if (request.method() === 'POST' && path === '/api/events') collectorBodies.push(request.postDataJSON());
  });
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async environment => {
    const { init } = await import('/sdk.js');
    const client = init({ project: 'browser-test', environment, endpoint: '/api/events',
      captureNetwork: false, captureResourceErrors: true, flushIntervalMs: 60_000 });
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const foreignImage = frame.contentDocument.createElement('img');
    const foreignRealm = foreignImage instanceof frame.contentWindow.HTMLImageElement;
    const mainRealm = foreignImage instanceof HTMLImageElement;
    foreignImage.alt = 'adopted-private-alt';
    const nativeError = new Promise((resolve, reject) => {
      foreignImage.addEventListener('error', resolve, { once: true });
      foreignImage.addEventListener('load', () => reject(new Error('adopted image unexpectedly loaded')), { once: true });
    });
    foreignImage.src = '/missing-resource-adopted.png?token=adopted-secret#fragment';
    document.body.append(foreignImage);
    await nativeError;
    await client.flush();
    const stats = client.getStats();
    client.destroy();
    return { foreignRealm, mainRealm, nativeHandlerFired: true, stats };
  }, environment);
  expect(result).toEqual({ foreignRealm: true, mainRealm: false, nativeHandlerFired: true,
    stats: { queued: 0, sent: 1, dropped: 0 } });
  expect(resourceRequests).toEqual(['/missing-resource-adopted.png']);
  expect(collectorBodies).toHaveLength(1);
  expect(collectorBodies[0].events).toHaveLength(1);
  expect(collectorBodies[0].events[0]).toMatchObject({ type: 'resource', name: 'ResourceLoadError',
    message: 'Failed to load img resource',
    context: { resourceTag: 'img', resourceUrl: `${origin}/missing-resource-adopted.png` } });
  expect(JSON.stringify(collectorBodies)).not.toMatch(/adopted-secret|adopted-private-alt|#fragment/);
  await expect.poll(async () => (await events(environment)).length).toBe(1);
});

test('delivers sanitized opt-in Error causes without changing the event wire shape', async ({ page }) => {
  const defaultEnvironment = randomUUID();
  const enabledEnvironment = randomUUID();
  const collectorBodies = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/events') {
      collectorBodies.push(request.postDataJSON());
    }
  });
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async ({ defaultEnvironment, enabledEnvironment }) => {
    const { init } = await import('/sdk.js');
    let causeReads = 0;
    const defaultClient = init({ project: 'browser-test', environment: defaultEnvironment,
      endpoint: '/api/events', captureNetwork: false, flushIntervalMs: 60_000 });
    const defaultError = new Error('default outer');
    Object.defineProperty(defaultError, 'cause', { get() {
      causeReads++;
      return new TypeError('default inner private');
    } });
    defaultClient.captureException(defaultError);
    await defaultClient.flush();
    const defaultStats = defaultClient.getStats();
    defaultClient.destroy();

    const enabledClient = init({ project: 'browser-test', environment: enabledEnvironment,
      endpoint: '/api/events', captureNetwork: false, captureErrorCause: true, flushIntervalMs: 60_000,
      beforeSend: event => {
        if (event.message === 'remove stack') delete event.stack;
        return event;
      } });
    const inner = new TypeError('inner failure');
    inner.stack = 'TypeError: inner failure\n    at run (https://cause-user:cause-pass@example.test/private/path?token=cause-query-secret#cause-fragment-secret)\n    at person@example.test Bearer causeBearerSecret';
    enabledClient.captureException(new Error('wrapped outer', { cause: inner }));
    enabledClient.captureException(new Error('remove stack', { cause: new Error('hidden inner') }));
    await enabledClient.flush();
    const enabledStats = enabledClient.getStats();
    enabledClient.destroy();
    return { causeReads, defaultStats, enabledStats };
  }, { defaultEnvironment, enabledEnvironment });

  expect(result).toEqual({ causeReads: 0,
    defaultStats: { queued: 0, sent: 1, dropped: 0 },
    enabledStats: { queued: 0, sent: 2, dropped: 0 } });
  expect(collectorBodies).toHaveLength(2);
  expect(collectorBodies.every(batch => batch.schemaVersion === 1 && Object.keys(batch).sort().join(',') === 'events,schemaVersion')).toBe(true);
  const defaultWire = collectorBodies.flatMap(batch => batch.events).filter(event => event.environment === defaultEnvironment);
  const enabledWire = collectorBodies.flatMap(batch => batch.events).filter(event => event.environment === enabledEnvironment);
  expect(defaultWire).toHaveLength(1);
  expect(defaultWire[0]).toMatchObject({ type: 'manual', name: 'Error', message: 'default outer' });
  expect(defaultWire[0].stack).not.toContain('default inner private');
  expect(enabledWire).toHaveLength(2);
  const wrapped = enabledWire.find(event => event.message === 'wrapped outer');
  const removed = enabledWire.find(event => event.message === 'remove stack');
  expect(wrapped).toMatchObject({ type: 'manual', name: 'Error', message: 'wrapped outer' });
  expect(wrapped.stack).toContain('Caused by: TypeError: inner failure');
  expect(wrapped.stack).toContain('https://example.test/private/path');
  expect(wrapped.stack.length).toBeLessThanOrEqual(4096);
  expect(removed).not.toHaveProperty('stack');
  expect(JSON.stringify(collectorBodies)).not.toMatch(/cause-user|cause-pass|cause-query-secret|cause-fragment-secret|person@example.test|causeBearerSecret|default inner private|hidden inner/);
  expect([...defaultWire, ...enabledWire].every(event => !Object.hasOwn(event, 'cause'))).toBe(true);

  await expect.poll(async () => (await events(defaultEnvironment)).length).toBe(1);
  await expect.poll(async () => (await events(enabledEnvironment)).length).toBe(2);
  const defaultStored = await events(defaultEnvironment);
  const enabledStored = await events(enabledEnvironment);
  expect(defaultStored[0]).toMatchObject(defaultWire[0]);
  for (const event of enabledWire) {
    const stored = enabledStored.find(item => item.eventId === event.eventId);
    expect(stored).toMatchObject(event);
    expect(Object.hasOwn(stored, 'stack')).toBe(Object.hasOwn(event, 'stack'));
  }
});

test('reports local diagnostics without changing delivery or the collector payload', async ({ page }) => {
  const environment = randomUUID();
  const failingEnvironment = randomUUID();
  const collectorPosts = [];
  const collectorBodies = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/events') {
      collectorBodies.push(request.postDataJSON());
    }
  });
  page.on('response', response => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/events') {
      collectorPosts.push(response.status());
    }
  });
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async ({ environment, failingEnvironment }) => {
    const { init } = await import('/sdk.js');
    const client = init({ project: 'browser-test', environment, endpoint: '/api/events',
      captureNetwork: false, maxEventsPerMinute: 1, flushIntervalMs: 60_000,
      beforeSend: event => event.message === 'filtered' ? false : event });
    client.captureException(new Error('filtered'));
    const afterFilter = client.getDiagnostics();
    const shared = new Error('admitted');
    client.captureException(shared);
    client.captureException(shared);
    client.captureException(new Error('rate limited'));
    const snapshot = client.getDiagnostics();
    const statsBeforeFlush = client.getStats();
    snapshot.filtered = 99;
    snapshot.droppedByReason.rateLimit = 99;
    const afterMutation = client.getDiagnostics();
    await client.flush();
    const afterFlush = client.getDiagnostics();
    const repeated = client.getDiagnostics();
    const statsAfterFlush = client.getStats();

    const failing = init({ project: 'browser-test', environment: failingEnvironment, endpoint: '/api/events',
      captureNetwork: false, getContext: () => { throw new Error('context failed'); } });
    failing.captureException(new Error('processing failed'));
    const beforeDestroy = failing.getDiagnostics();
    failing.destroy();
    const afterDestroy = failing.getDiagnostics();
    client.destroy();
    return { afterFilter, afterMutation, afterFlush, repeated, statsBeforeFlush, statsAfterFlush,
      beforeDestroy, afterDestroy };
  }, { environment, failingEnvironment });

  const emptyReasons = { rateLimit: 0, queueOverflow: 0, payloadTooLarge: 0,
    processingError: 0, deliveryError: 0, destroyed: 0 };
  expect(result.afterFilter).toEqual({ queued: 0, sent: 0, dropped: 0, inFlight: 0,
    filtered: 1, deduplicated: 0, droppedByReason: emptyReasons });
  expect(result.afterMutation).toEqual({ queued: 1, sent: 0, dropped: 1, inFlight: 0,
    filtered: 1, deduplicated: 1, droppedByReason: { ...emptyReasons, rateLimit: 1 } });
  expect(result.statsBeforeFlush).toEqual({ queued: 1, sent: 0, dropped: 1 });
  const deliveredDiagnostics = { queued: 0, sent: 1, dropped: 1, inFlight: 0,
    filtered: 1, deduplicated: 1, droppedByReason: { ...emptyReasons, rateLimit: 1 } };
  expect(result.afterFlush).toEqual(deliveredDiagnostics);
  expect(result.repeated).toEqual(deliveredDiagnostics);
  expect(result.statsAfterFlush).toEqual({ queued: 0, sent: 1, dropped: 1 });
  const processingDiagnostics = { queued: 0, sent: 0, dropped: 1, inFlight: 0,
    filtered: 0, deduplicated: 0, droppedByReason: { ...emptyReasons, processingError: 1 } };
  expect(result.beforeDestroy).toEqual(processingDiagnostics);
  expect(result.afterDestroy).toEqual(processingDiagnostics);
  for (const diagnostics of [result.afterMutation, result.afterFlush, result.afterDestroy]) {
    expect(Object.values(diagnostics.droppedByReason).reduce((sum, count) => sum + count, 0)).toBe(diagnostics.dropped);
  }
  expect(collectorPosts).toEqual([200]);
  expect(collectorBodies).toHaveLength(1);
  expect(collectorBodies[0]).toMatchObject({ schemaVersion: 1, events: [{ message: 'admitted' }] });
  expect(Object.keys(collectorBodies[0]).sort()).toEqual(['events', 'schemaVersion']);
  expect(JSON.stringify(collectorBodies[0])).not.toMatch(/droppedByReason|filtered|deduplicated|rateLimit|inFlight/);
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  const [delivered] = await events(environment);
  expect(delivered.message).toBe('admitted');
  expect(JSON.stringify(delivered)).not.toMatch(/droppedByReason|filtered|deduplicated|rateLimit|inFlight/);
  expect(await events(failingEnvironment)).toHaveLength(0);
});

test('ignores final sanitized messages without spending browser rate capacity', async ({ page }) => {
  const environment = randomUUID();
  const collectorBodies = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/events') {
      collectorBodies.push(request.postDataJSON());
    }
  });
  await page.goto(`${origin}/`);
  const diagnostics = await page.evaluate(async environment => {
    const { init } = await import('/sdk.js');
    const client = init({ project: 'browser-test', environment, endpoint: '/api/events',
      captureNetwork: false, flushIntervalMs: 60_000, maxEventsPerMinute: 1,
      ignoreMessages: ['Expected noise'],
      beforeSend: event => {
        if (event.message === 'alias noise') event.message = 'Expected noise normalized';
        return event;
      } });
    try {
      client.captureException(new Error('Expected noise from manual capture'));
      client.captureException(new Error('alias noise'));
      client.captureException(new Error('unexpected error'));
      await client.flush();
      return client.getDiagnostics();
    } finally {
      client.destroy();
    }
  }, environment);

  expect(diagnostics).toMatchObject({ queued: 0, sent: 1, dropped: 0, filtered: 2,
    droppedByReason: { rateLimit: 0 } });
  expect(collectorBodies).toHaveLength(1);
  expect(collectorBodies[0]).toMatchObject({ schemaVersion: 1, events: [{ message: 'unexpected error' }] });
  expect(Object.keys(collectorBodies[0]).sort()).toEqual(['events', 'schemaVersion']);
  expect(collectorBodies[0].events).toHaveLength(1);
  expect(JSON.stringify(collectorBodies[0])).not.toMatch(/ignoreMessages|Expected noise/);
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  expect((await events(environment)).map(event => event.message)).toEqual(['unexpected error']);
});

test('limits admitted browser events per client across sources and flushes', async ({ page }) => {
  const environment = randomUUID();
  const otherEnvironment = randomUUID();
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async ({ environment, otherEnvironment }) => {
    const { init } = await import('/sdk.js');
    let beforeSendCalls = 0;
    const client = init({ project: 'browser-test', environment, endpoint: '/api/events',
      captureConsole: true, shouldCaptureHttp: () => true, maxEventsPerMinute: 2,
      flushIntervalMs: 60_000, beforeSend: event => { beforeSendCalls++; return event; } });
    client.addBreadcrumb({ category: 'action', message: 'Before capacity' });
    console.error('capacity console', new Error('console failure'));
    client.captureException(new Error('capacity manual'));
    await client.flush();
    const afterFirstFlush = client.getStats();

    client.addBreadcrumb({ category: 'action', message: 'After capacity' });
    const afterBreadcrumb = client.getStats();
    const response = await fetch('/api/health');
    const responseBody = await response.text();
    const afterHttp = client.getStats();
    client.captureException(new Error('throttled manual one'));
    await client.flush();
    client.captureException(new Error('throttled manual two'));
    await client.flush();
    const afterRetries = client.getStats();

    let otherBeforeSendCalls = 0;
    const otherClient = init({ project: 'browser-test', environment: otherEnvironment, endpoint: '/api/events',
      captureNetwork: false, maxEventsPerMinute: 2, beforeSend: event => { otherBeforeSendCalls++; return event; } });
    otherClient.captureException(new Error('independent client'));
    await otherClient.flush();
    const otherStats = otherClient.getStats();
    otherClient.destroy();
    client.destroy();
    return { afterFirstFlush, afterBreadcrumb, afterHttp, afterRetries, otherStats,
      beforeSendCalls, otherBeforeSendCalls, responseStatus: response.status, responseOk: response.ok,
      responseBodyLength: responseBody.length };
  }, { environment, otherEnvironment });

  expect(result.afterFirstFlush).toMatchObject({ queued: 0, sent: 2, dropped: 0 });
  expect(result.afterBreadcrumb).toEqual(result.afterFirstFlush);
  expect(result).toMatchObject({ responseStatus: 200, responseOk: true,
    afterHttp: { queued: 0, sent: 2, dropped: 1 },
    afterRetries: { queued: 0, sent: 2, dropped: 3 },
    otherStats: { queued: 0, sent: 1, dropped: 0 },
    beforeSendCalls: 2, otherBeforeSendCalls: 1 });
  expect(result.responseBodyLength).toBeGreaterThan(0);
  await expect.poll(async () => (await events(environment)).length).toBe(2);
  const delivered = await events(environment);
  expect(delivered.map(event => event.type).sort()).toEqual(['console', 'manual']);
  expect(delivered.find(event => event.type === 'console').message).toContain('capacity console');
  expect(delivered.find(event => event.type === 'manual').message).toBe('capacity manual');
  expect(delivered.find(event => event.type === 'manual').breadcrumbs.map(entry => entry.message)).toEqual(['Before capacity']);
  expect((await events(otherEnvironment)).map(event => event.message)).toEqual(['independent client']);
});

test('keeps fetch and XHR context without creating error events or exposing payloads', async ({ page }) => {
  const environment = randomUUID();
  const received = [];
  const network = createHttpServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Test-Request');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Expose-Headers', 'X-Test-Response');
    response.setHeader('X-Test-Response', 'private-response-header');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received.push({ method: request.method, url: request.url, body, header: request.headers['x-test-request'] });
      const finish = () => {
        response.writeHead(request.url.startsWith('/missing') ? 404 : request.url.startsWith('/unavailable') ? 503 : 200,
          { 'Content-Type': 'text/plain' });
        response.end('private-response-body');
      };
      if (request.url.startsWith('/slow')) {
        const timer = setTimeout(finish, 1000);
        response.on('close', () => clearTimeout(timer));
      } else finish();
    });
  });
  await new Promise(resolve => network.listen(0, '127.0.0.1', resolve));
  const networkOrigin = `http://127.0.0.1:${network.address().port}`;
  const refusedPort = await availablePort();
  try {
    await page.goto(`${origin}/`);
    const result = await page.evaluate(async ({ environment, networkOrigin, refusedPort }) => {
      const { init } = await import('/sdk.js');
      const client = init({ project: 'browser-test', environment, endpoint: '/api/events',
        captureNetwork: false, captureNetworkBreadcrumbs: true });
      const response = await fetch(`${networkOrigin}/ok?token=hidden`, { method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-Test-Request': 'private-request-header' }, body: 'private-request-body' });
      const body = await response.text();
      const header = response.headers.get('x-test-response');
      const xhr = new XMLHttpRequest();
      const finished = new Promise(resolve => xhr.addEventListener('loadend', resolve, { once: true }));
      xhr.open('GET', `${networkOrigin}/missing?token=hidden`);
      xhr.send();
      await finished;
      const unavailable = await fetch(`${networkOrigin}/unavailable?token=hidden`);
      let rejected = false;
      try { await fetch(`http://127.0.0.1:${refusedPort}/offline?token=hidden`); } catch { rejected = true; }
      const controller = new AbortController();
      const cancelled = fetch(`${networkOrigin}/slow?token=hidden`, { signal: controller.signal }).catch(error => error.name);
      setTimeout(() => controller.abort(), 30);
      const abortName = await cancelled;
      const beforeCapture = client.getStats();
      client.captureException(new Error('network context before error'));
      await client.flush();
      client.captureException(new Error('collector request stays excluded'));
      await client.flush();
      const afterCapture = client.getStats();
      client.destroy();
      return { status: response.status, body, header, xhrStatus: xhr.status, xhrBody: xhr.responseText,
        unavailableStatus: unavailable.status, rejected, abortName, beforeCapture, afterCapture };
    }, { environment, networkOrigin, refusedPort });
    expect(result).toMatchObject({ status: 200, body: 'private-response-body', header: 'private-response-header',
      xhrStatus: 404, xhrBody: 'private-response-body', unavailableStatus: 503, rejected: true, abortName: 'AbortError',
      beforeCapture: { queued: 0, sent: 0, dropped: 0 }, afterCapture: { queued: 0, sent: 2, dropped: 0 } });
    expect(received.find(request => request.method === 'POST')).toEqual({ method: 'POST', url: '/ok?token=hidden',
      body: 'private-request-body', header: 'private-request-header' });
    const delivered = await events(environment);
    expect(delivered).toHaveLength(2);
    const first = delivered.find(event => event.message === 'network context before error');
    expect(first.breadcrumbs.map(entry => [entry.category, entry.data.method, entry.data.url, entry.data.status])).toEqual([
      ['http', 'POST', `${networkOrigin}/ok`, 200], ['http', 'GET', `${networkOrigin}/missing`, 404],
      ['http', 'GET', `${networkOrigin}/unavailable`, 503], ['network', 'GET', `http://127.0.0.1:${refusedPort}/offline`, undefined],
    ]);
    expect(first.breadcrumbs.every(entry => Number.isInteger(entry.data.durationMs) && entry.data.durationMs >= 0)).toBe(true);
    expect(delivered.find(event => event.message === 'collector request stays excluded').breadcrumbs).toEqual(first.breadcrumbs);
    expect(JSON.stringify(delivered)).not.toMatch(/private-request|private-response|token=|\/slow|\/api\/events/);
    await page.goto(`${origin}/viewer.html`);
    await page.locator('.language-switcher select').selectOption('en');
    await page.locator('.dash-filters').getByLabel('Environment', { exact: true }).fill(environment);
    await page.locator('.dash-filters').getByRole('button', { name: /Query/ }).click();
    await page.getByRole('button').filter({ hasText: 'network context before error' }).click();
    const trail = page.getByRole('dialog').locator('.breadcrumb-trail');
    await expect(trail.locator('.breadcrumb-network-summary')).toHaveCount(4);
    await expect(trail).toContainText('Status unavailable');
    await expect(trail.locator('details[open]')).toHaveCount(0);
    await trail.screenshot({ path: resolve(`output/playwright/network-${test.info().project.name}-desktop.png`) });
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(trail).toBeVisible();
    expect(await trail.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await trail.screenshot({ path: resolve(`output/playwright/network-${test.info().project.name}-mobile.png`) });
  } finally {
    network.closeAllConnections();
    await new Promise(resolve => network.close(resolve));
  }
});

test('records native SPA navigation without exposing state or changing History semantics', async ({ page }) => {
  const optedOutEnvironment = randomUUID();
  const environment = randomUUID();
  await page.goto(`${origin}/`);
  const native = await page.evaluate(async ({ environment, optedOutEnvironment }) => {
    const { init } = await import('/sdk.js');
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const errorName = callback => { try { callback(); return 'none'; } catch (error) { return error.name; } };
    const baselineError = errorName(() => originalPush.call(history, {}, '', 'https://other.invalid/forbidden'));
    const optedOut = init({ project: 'browser-test', environment: optedOutEnvironment, endpoint: '/api/events', captureNetwork: false });
    history.pushState({ privateState: 'opted-out-state' }, '', '/cart?token=hidden#part');
    optedOut.captureException(new Error('navigation opted out'));
    await optedOut.flush();
    optedOut.destroy();

    const client = init({ project: 'browser-test', environment, endpoint: '/api/events', captureNetwork: false, captureNavigation: true });
    const pushResult = history.pushState({ privateState: 'secret-state-payload' }, 'private title', '/checkout?token=hidden#part');
    const keptState = history.state.privateState;
    const replaceResult = history.replaceState({ privateState: 'replacement-state-payload' }, '', '/payment?token=hidden');
    history.pushState({ privateState: 'query-state-payload' }, '', '/payment?token=changed#part');
    const capturedError = errorName(() => history.pushState({}, '', 'https://other.invalid/forbidden'));
    const cloneError = errorName(() => history.pushState({ callback: () => {} }, '', '/cannot-clone'));
    const move = direction => new Promise(resolve => {
      window.addEventListener('popstate', resolve, { once: true });
      history[direction]();
    });
    await move('back'); // same filtered /payment URL: omitted
    await move('back'); // /payment -> /cart
    await move('forward'); // /cart -> /payment
    client.captureException(new Error('navigation captured'));
    client.clearBreadcrumbs();
    history.pushState({ privateState: 'next-state-payload' }, '', '/account?token=hidden#part');
    client.captureException(new Error('navigation after clear'));
    await client.flush();
    client.destroy();
    return { pushResult, replaceResult, keptState, baselineError, capturedError, cloneError,
      restored: history.pushState === originalPush && history.replaceState === originalReplace,
      href: location.href, state: history.state };
  }, { environment, optedOutEnvironment });
  expect(native).toMatchObject({ pushResult: undefined, replaceResult: undefined, keptState: 'secret-state-payload',
    baselineError: 'SecurityError', capturedError: 'SecurityError', cloneError: 'DataCloneError', restored: true,
    href: `${origin}/account?token=hidden#part`, state: { privateState: 'next-state-payload' } });
  expect((await events(optedOutEnvironment))[0].breadcrumbs).toBeUndefined();
  const delivered = await events(environment);
  const first = delivered.find(event => event.message === 'navigation captured');
  expect(first.breadcrumbs.map(entry => [entry.category, entry.data.trigger, entry.data.from, entry.data.to])).toEqual([
    ['navigation', 'pushState', `${origin}/cart`, `${origin}/checkout`],
    ['navigation', 'replaceState', `${origin}/checkout`, `${origin}/payment`],
    ['navigation', 'popstate', `${origin}/payment`, `${origin}/cart`],
    ['navigation', 'popstate', `${origin}/cart`, `${origin}/payment`],
  ]);
  const second = delivered.find(event => event.message === 'navigation after clear');
  expect(second.breadcrumbs).toHaveLength(1);
  expect(second.breadcrumbs[0].data).toEqual({ from: `${origin}/payment`, to: `${origin}/account`, trigger: 'pushState' });
  expect(JSON.stringify(delivered)).not.toMatch(/privateState|state-payload|private title|token=|#part|cannot-clone/);
});

test('preserves manual steps through SDK delivery, both viewer details, and history export', async ({ page }) => {
  const environment = randomUUID();
  await init(page, environment);
  await page.evaluate(async () => {
    window.testClient.addBreadcrumb({ category: 'navigation', message: 'Checkout opened',
      data: { email: 'demo@example.test', password: 'fakepass', route: '/checkout?token=hidden' } });
    window.testClient.addBreadcrumb({ category: 'action', message: 'Order submitted', data: { attempt: 1 } });
    window.testClient.captureException(new Error('breadcrumb checkout failure'));
    window.testClient.clearBreadcrumbs();
    window.testClient.captureException(new Error('after clear failure'));
    await window.testClient.flush();
    window.testClient.destroy();
  });
  await expect.poll(async () => (await events(environment)).length).toBe(2);
  const delivered = await events(environment);
  const captured = delivered.find(event => event.message === 'breadcrumb checkout failure');
  expect(captured.breadcrumbs.map(entry => entry.message)).toEqual(['Checkout opened', 'Order submitted']);
  expect(captured.breadcrumbs[0].data).toEqual({ email: '[REDACTED_EMAIL]', route: '/checkout' });
  expect(delivered.find(event => event.message === 'after clear failure').breadcrumbs).toBeUndefined();
  expect(JSON.stringify(delivered)).not.toMatch(/demo@example|fakepass|token=hidden/);

  await page.goto(`${origin}/viewer.html`);
  await page.locator('.language-switcher select').selectOption('en');
  await page.locator('.dash-filters').getByLabel('Environment', { exact: true }).fill(environment);
  await page.locator('.dash-filters').getByRole('button', { name: /Query/ }).click();
  await page.getByRole('button').filter({ hasText: 'breadcrumb checkout failure' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Activity before this error' })).toBeVisible();
  await expect(dialog.locator('.breadcrumb-entry')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Close details' }).click();
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save query data ↓' }).click();
  const download = await pendingDownload;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported.events.find(event => event.eventId === captured.eventId).breadcrumbs).toEqual(captured.breadcrumbs);

  await page.getByRole('button', { name: 'Event Timeline', exact: true }).last().click();
  await page.getByLabel('Environment', { exact: true }).last().fill(environment);
  await page.locator('.event-row').filter({ hasText: 'breadcrumb checkout failure' }).click();
  const inspector = page.locator('.detail-panel');
  await expect(inspector.locator('.breadcrumb-entry')).toHaveCount(2);
  await inspector.locator('.breadcrumb-trail').screenshot({ path: resolve(`output/playwright/breadcrumbs-${test.info().project.name}-desktop.png`) });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('.language-switcher select').selectOption('ko');
  await expect(inspector.getByRole('heading', { name: '오류 전 작업 기록' })).toBeVisible();
  expect(await inspector.locator('.breadcrumb-trail').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await inspector.locator('.breadcrumb-trail').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(`output/playwright/breadcrumbs-${test.info().project.name}-mobile.png`) });
});

test('delivers an uncaught runtime error to the local collector', async ({ page }) => {
  const environment = randomUUID();
  await init(page, environment);
  await page.evaluate(() => setTimeout(() => { throw new Error('synthetic runtime failure'); }, 0));
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  const [event] = await events(environment);
  expect(event).toMatchObject({ type: 'javascript', message: 'synthetic runtime failure', project: 'browser-test' });
  expect(event.page).toBe(`${origin}/`);
  expect(JSON.stringify(event)).not.toContain('synthetic-page-secret');
});

test('delivers event-time metadata and a per-event override to the local collector', async ({ page }) => {
  const environment = randomUUID();
  await page.goto(`${origin}/`);
  await page.evaluate(async environment => {
    const { init } = await import('/sdk.js');
    let screen = 'cart';
    const shared = { team: 'checkout', attempt: 2, password: 'synthetic-private-value' };
    const client = init({ project: 'browser-test', environment, endpoint: '/api/events', context: shared,
      getContext: () => ({ screen, team: 'dynamic' }) });
    client.captureException(new Error('first state'), { context: { team: 'billing', source: 'button' } });
    screen = 'payment';
    client.captureException(new Error('second state'));
    await client.flush();
    client.destroy();
  }, environment);
  await expect.poll(async () => (await events(environment)).length).toBe(2);
  const delivered = await events(environment);
  const first = delivered.find(event => event.message === 'first state');
  const second = delivered.find(event => event.message === 'second state');
  expect(first).toMatchObject({ type: 'manual', message: 'first state', context: {
    team: 'billing', source: 'button', screen: 'cart', attempt: 2,
  } });
  expect(second).toMatchObject({ type: 'manual', message: 'second state', context: {
    team: 'dynamic', screen: 'payment', attempt: 2,
  } });
  expect(JSON.stringify(delivered)).not.toContain('synthetic-private-value');
});

test('delivers native source location for a primitive thrown by an external script', async ({ page }) => {
  const environment = randomUUID();
  await init(page, environment);
  const native = await page.evaluate(() => new Promise(resolve => {
    window.addEventListener('error', event => resolve({ filename: event.filename, lineno: event.lineno, colno: event.colno }), { once: true });
    const script = document.createElement('script');
    script.src = '/source-location.js?token=synthetic-source-secret';
    document.body.append(script);
  }));
  expect(native).toMatchObject({ filename: `${origin}/source-location.js?token=synthetic-source-secret`, lineno: 1 });
  expect(native.colno).toBeGreaterThan(0);
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  const [event] = await events(environment);
  expect(event).toMatchObject({ type: 'javascript', context: {
    filename: `${origin}/source-location.js`, lineno: native.lineno, colno: native.colno,
  } });
  expect(event.message).toContain('synthetic source failure');
  expect(JSON.stringify(event)).not.toContain('synthetic-source-secret');
});

test('delivers an unhandled promise rejection to the local collector', async ({ page }) => {
  const environment = randomUUID();
  await init(page, environment);
  await page.evaluate(() => { void Promise.reject(new Error('synthetic promise failure')); });
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  expect((await events(environment))[0]).toMatchObject({ type: 'promise', message: 'synthetic promise failure' });
});

test('keeps manual promise and native errors when automatic promise capture is disabled', async ({ page }) => {
  const enabledEnvironment = randomUUID();
  const disabledEnvironment = randomUUID();
  await page.goto(`${origin}/`);
  await page.evaluate(async ({ enabledEnvironment, disabledEnvironment }) => {
    const { init } = await import('/sdk.js');
    window.beforeSendCalls = { enabled: 0, disabled: 0 };
    const common = { project: 'browser-test', endpoint: '/api/events', captureNetwork: false, flushIntervalMs: 60_000 };
    window.enabledClient = init({ ...common, environment: enabledEnvironment,
      beforeSend: event => { window.beforeSendCalls.enabled++; return event; } });
    window.disabledClient = init({ ...common, environment: disabledEnvironment, captureUnhandledRejections: false,
      beforeSend: event => { window.beforeSendCalls.disabled++; return event; } });
    void Promise.reject(new Error('automatic rejection'));
  }, { enabledEnvironment, disabledEnvironment });
  await expect.poll(() => page.evaluate(() => window.enabledClient.getStats().queued)).toBe(1);
  expect(await page.evaluate(() => ({ stats: window.disabledClient.getStats(), calls: window.beforeSendCalls })))
    .toEqual({ stats: { queued: 0, sent: 0, dropped: 0 }, calls: { enabled: 1, disabled: 0 } });

  await page.evaluate(() => {
    window.disabledClient.captureException(new Error('manual promise'), { type: 'promise' });
    setTimeout(() => { throw new Error('native javascript'); }, 0);
  });
  await expect.poll(() => page.evaluate(() => ({
    enabled: window.enabledClient.getStats().queued, disabled: window.disabledClient.getStats().queued,
  }))).toEqual({ enabled: 2, disabled: 2 });
  expect(await page.evaluate(() => window.beforeSendCalls)).toEqual({ enabled: 2, disabled: 2 });
  await page.evaluate(async () => {
    await Promise.all([window.enabledClient.flush(), window.disabledClient.flush()]);
    window.enabledClient.destroy();
    window.disabledClient.destroy();
  });
  await expect.poll(async () => (await events(enabledEnvironment)).length).toBe(2);
  await expect.poll(async () => (await events(disabledEnvironment)).length).toBe(2);
  const byMessage = (a, b) => a.message.localeCompare(b.message);
  expect((await events(enabledEnvironment)).map(({ type, message }) => ({ type, message })).sort(byMessage))
    .toEqual([{ type: 'promise', message: 'automatic rejection' },
      { type: 'javascript', message: 'native javascript' }].sort(byMessage));
  expect((await events(disabledEnvironment)).map(({ type, message }) => ({ type, message })).sort(byMessage))
    .toEqual([{ type: 'promise', message: 'manual promise' },
      { type: 'javascript', message: 'native javascript' }].sort(byMessage));
});

test('opt-in console.error delivers the first named Error without changing native return', async ({ page }) => {
  const optedOutEnvironment = randomUUID();
  await init(page, optedOutEnvironment);
  await page.evaluate(async () => {
    console.error('opted out', new Error('ignored'));
    await window.testClient.flush();
    window.testClient.destroy();
  });
  expect(await events(optedOutEnvironment)).toHaveLength(0);

  const environment = randomUUID();
  await page.evaluate(async environment => {
    const { init } = await import('/sdk.js');
    window.testClient = init({ project: 'browser-test', environment, endpoint: '/api/events', captureConsole: true });
  }, environment);
  const result = await page.evaluate(async () => {
    function makeFailure() { return new TypeError('synthetic console failure'); }
    const error = makeFailure();
    const nativeReturn = console.error('prefix', error, 'suffix');
    await window.testClient.flush();
    return { nativeReturn, message: ['prefix', error, 'suffix'].map(String).join(' ') };
  });
  expect(result.nativeReturn).toBeUndefined();
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  const [event] = await events(environment);
  expect(event).toMatchObject({ type: 'console', message: result.message, name: 'TypeError' });
  expect(event.stack).toContain('makeFailure');
});

test('delivers selected HTTP and fetch failures without recapturing collector requests', async ({ page }) => {
  const environment = randomUUID();
  await init(page, environment, true);
  const refusedPort = await availablePort();
  await page.evaluate(async refusedPort => {
    await fetch('/missing?token=synthetic-request-secret');
    try { await fetch(`http://127.0.0.1:${refusedPort}/offline?secret=synthetic-network-secret`); }
    catch { /* an expected network failure */ }
  }, refusedPort);
  await expect.poll(async () => (await events(environment)).length).toBe(2);
  const delivered = await events(environment);
  expect(delivered.map(event => event.type).sort()).toEqual(['http', 'network']);
  expect(delivered.find(event => event.type === 'http').network).toMatchObject({ method: 'GET', status: 404, url: `${origin}/missing` });
  expect(delivered.find(event => event.type === 'network').network.url).toBe(`http://127.0.0.1:${refusedPort}/offline`);
  expect(JSON.stringify(delivered)).not.toContain('synthetic-request-secret');
  expect(JSON.stringify(delivered)).not.toContain('synthetic-network-secret');
  await delay(150);
  expect(await events(environment)).toHaveLength(2);
});

test('honors a null signal override on an aborted Request', async ({ page }) => {
  const refusedPort = await availablePort();
  const url = `http://127.0.0.1:${refusedPort}/offline`;
  await page.goto(`${origin}/`);
  const native = await page.evaluate(async url => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request(url, { signal: controller.signal });
    const sameOriginRequest = new Request('/missing', { signal: controller.signal });
    const sameOriginStatus = (await fetch(sameOriginRequest, { signal: null })).status;
    const rejectName = async init => {
      try { await fetch(request, init); return 'resolved'; }
      catch (error) { return error.name; }
    };
    return {
      sameOriginStatus,
      omitted: await rejectName(),
      undefined: await rejectName({ signal: undefined }),
      null: await rejectName({ signal: null }),
    };
  }, url);
  expect(native.sameOriginStatus).toBe(404);
  expect(native.omitted).toBe('AbortError');
  expect(native.undefined).toBe('AbortError');
  expect(native.null).toBe('TypeError');

  const environment = randomUUID();
  await init(page, environment);
  const wrapped = await page.evaluate(async url => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request(url, { signal: controller.signal });
    const rejectName = async init => {
      try { await fetch(request, init); return 'resolved'; }
      catch (error) { return error.name; }
    };
    return {
      omitted: await rejectName(),
      undefined: await rejectName({ signal: undefined }),
      null: await rejectName({ signal: null }),
    };
  }, url);
  expect(wrapped).toEqual({ omitted: native.omitted, undefined: native.undefined, null: native.null });
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  expect((await events(environment))[0]).toMatchObject({ type: 'network', network: { url } });
});

test('records a Request created in an iframe while preserving native fetch', async ({ page }) => {
  const environment = randomUUID();
  await init(page, environment, true);
  const result = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    try {
      const request = new frame.contentWindow.Request('/missing?token=iframe-secret', { method: 'POST', body: 'payload' });
      const response = await window.fetch(request);
      return { foreign: !(request instanceof Request), nativeResponse: response instanceof Response, status: response.status };
    } finally { frame.remove(); }
  });
  expect(result).toMatchObject({ foreign: true, nativeResponse: true, status: 404 });
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  expect((await events(environment))[0].network).toMatchObject({ method: 'POST', url: `${origin}/missing`, status: 404 });
});

test('records only the latest request when an active XHR is reopened', async ({ page }) => {
  const environment = randomUUID();
  await init(page, environment, true);
  const nativeEvents = await page.evaluate(async () => {
    const xhr = new XMLHttpRequest();
    const events = [];
    let phase = 'old';
    xhr.addEventListener('abort', () => events.push({ phase, type: 'abort', status: xhr.status }));
    xhr.addEventListener('loadend', () => events.push({ phase, type: 'loadend', status: xhr.status }));
    const completed = new Promise(resolve => xhr.addEventListener('loadend', () => {
      if (phase === 'new') resolve();
    }));
    xhr.open('GET', '/old');
    xhr.send();
    phase = 'opening-new';
    xhr.open('GET', '/new');
    phase = 'new';
    xhr.send();
    await completed;
    return events;
  });
  expect(nativeEvents).toEqual([{ phase: 'new', type: 'loadend', status: 404 }]);
  await expect.poll(async () => (await events(environment)).length).toBeGreaterThanOrEqual(1);
  expect((await events(environment)).map(event => event.network?.url)).toEqual([`${origin}/new`]);
});

test('keeps an active XHR request when reopening throws', async ({ page }) => {
  const environment = randomUUID();
  await init(page, environment, true);
  const result = await page.evaluate(async () => {
    const xhr = new XMLHttpRequest();
    const completed = new Promise(resolve => xhr.addEventListener('loadend', resolve, { once: true }));
    xhr.open('GET', '/kept');
    xhr.send();
    let openThrew = false;
    try { xhr.open('GET', 'http://['); }
    catch { openThrew = true; }
    await completed;
    return { openThrew, status: xhr.status };
  });
  expect(result).toEqual({ openThrew: true, status: 404 });
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  expect((await events(environment))[0].network).toMatchObject({ url: `${origin}/kept`, status: 404 });
});
