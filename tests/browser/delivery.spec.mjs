import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  expect(response.ok).toBe(true);
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
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>SDK browser delivery test</title>');
  await writeFile(join(publicDir, 'source-location.js'), "throw 'synthetic source failure';\n");
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MICRO_')));
  collector = spawn(process.execPath, [resolve('dist/micro-server/server.mjs')], {
    env: { ...env, MICRO_HOST: '127.0.0.1', MICRO_PORT: String(port),
      MICRO_PROJECTS: 'browser-test', MICRO_STORAGE: 'sqlite',
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
