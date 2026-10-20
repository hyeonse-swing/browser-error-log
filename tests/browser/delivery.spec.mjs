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

test('delivers an unhandled promise rejection to the local collector', async ({ page }) => {
  const environment = randomUUID();
  await init(page, environment);
  await page.evaluate(() => { void Promise.reject(new Error('synthetic promise failure')); });
  await expect.poll(async () => (await events(environment)).length).toBe(1);
  expect((await events(environment))[0]).toMatchObject({ type: 'promise', message: 'synthetic promise failure' });
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
