import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createPortProbe } from 'node:net';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

const sdkVersion = JSON.parse(await readFile(new URL('../../packages/browser/package.json', import.meta.url), 'utf8')).version;

let scratch;
let fixture;
let collector;
let origin;
let publicDir;

async function availablePort() {
  const server = createPortProbe();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function receivedEvents() {
  const response = await fetch(`${origin}/api/events?project=source-map-example&environment=local`);
  expect(response.ok).toBe(true);
  return (await response.json()).events;
}

async function trigger(page, release) {
  await copyFile(fixture.expected[release].bundle, join(publicDir, 'assets', 'app.js'));
  await page.goto(`${origin}/browser.html?release=${release}`);
  await page.waitForFunction(() => window.__sourceMapFixtureReady === true);
  await page.getByRole('button', { name: 'Trigger fixture error' }).click();
  await page.evaluate(() => window.__sourceMapFixtureClient.flush());
  await expect.poll(async () => (await receivedEvents()).filter(event => event.release === release).length).toBe(1);
  const [event] = (await receivedEvents()).filter(item => item.release === release);
  expect(event.sdkVersion).toBe(sdkVersion);
  expect(event.stack).toMatch(/\/assets\/app\.js:\d+:\d+/);
  expect(JSON.stringify(event)).not.toMatch(/private-fixture|private-fragment/);
  return event;
}

async function register(panel, manifest, map) {
  await panel.getByLabel('Registration manifest').setInputFiles(manifest);
  await panel.getByLabel('Source map file').setInputFiles(map);
  await panel.getByRole('button', { name: 'Register map' }).click();
}

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'browser-source-maps-'));
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  const fixtureJson = execFileSync(process.execPath, [
    resolve('examples/source-maps/build-fixture.mjs'), '--output-dir', join(scratch, 'fixture'),
    '--asset-url', `${origin}/assets/app.js`,
  ], { encoding: 'utf8' });
  fixture = JSON.parse(fixtureJson);
  publicDir = join(scratch, 'public');
  await mkdir(join(publicDir, 'assets'), { recursive: true });
  await copyFile('packages/browser/dist/index.js', join(publicDir, 'sdk.js'));
  await copyFile('dist/viewer/index.html', join(publicDir, 'viewer.html'));
  await copyFile('examples/source-maps/browser.html', join(publicDir, 'browser.html'));
  await cp('dist/viewer/assets', join(publicDir, 'assets'), { recursive: true });
  await copyFile(fixture.expected.A.bundle, join(publicDir, 'assets', 'app.js'));

  const conflictingMap = join(scratch, 'conflicting.map');
  await writeFile(conflictingMap, `${await readFile(fixture.expected.B.map, 'utf8')}\n`);
  const conflictingManifest = join(scratch, 'conflicting-manifest.json');
  execFileSync(process.execPath, [resolve('scripts/prepare-source-map.mjs'),
    '--project', 'source-map-example', '--environment', 'local', '--release', 'B',
    '--url', `${origin}/assets/app.js`, '--bundle', fixture.expected.B.bundle,
    '--map', conflictingMap, '--out', conflictingManifest], { stdio: 'pipe' });
  fixture.conflict = { map: conflictingMap, manifest: conflictingManifest };

  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MICRO_')));
  collector = spawn(process.execPath, [resolve('dist/micro-server/server.mjs')], {
    env: { ...environment, MICRO_HOST: '127.0.0.1', MICRO_PORT: String(port),
      MICRO_PROJECTS: 'source-map-example', MICRO_STORAGE: 'sqlite',
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

test('maps two captured releases in both viewer details without changing event data', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  const eventA = await trigger(page, 'A');
  const eventB = await trigger(page, 'B');
  expect(eventA.eventId).not.toBe(eventB.eventId);
  const before = await receivedEvents();

  await page.goto(`${origin}/viewer.html`);
  await page.locator('.language-switcher select').selectOption('en');
  await page.getByRole('button', { name: 'Event Timeline', exact: true }).last().click();
  await expect(page.locator('.event-row')).toHaveCount(2);
  const rows = page.locator('.event-row');
  const inspector = page.locator('.detail-panel');
  const locations = inspector.getByRole('region', { name: 'Original locations' });
  const panel = page.locator('.source-map-panel').first();
  await panel.locator('summary').click();

  await rows.nth(1).click();
  await expect(inspector.getByText('Release', { exact: true }).locator('..')).toContainText('A');
  await expect(locations).toContainText('No map is registered');
  await register(panel, fixture.expected.A.manifest, fixture.expected.A.map);
  await expect(panel.getByRole('status')).toContainText('Source map registered');
  await expect(locations).toContainText('release-a.ts:2:3');
  await expect(locations).toContainText(`${origin}/assets/app.js:`);
  await expect(inspector.locator('.code-block').first()).toContainText('/assets/app.js:');

  await rows.nth(0).click();
  await expect(inspector.getByText('Release', { exact: true }).locator('..')).toContainText('B');
  await expect(locations).toContainText('No map is registered');
  await register(panel, fixture.expected.B.manifest, fixture.expected.B.map);
  await expect(locations).toContainText('release-b.ts:7:3');

  const wrongMap = join(scratch, 'wrong.map');
  await writeFile(wrongMap, `${await readFile(fixture.expected.A.map, 'utf8')} `);
  await register(panel, fixture.expected.A.manifest, wrongMap);
  await expect(panel.getByRole('alert')).toContainText('does not match its manifest hash');
  await expect(locations).toContainText('release-b.ts:7:3');

  await register(panel, fixture.conflict.manifest, fixture.conflict.map);
  await expect(panel).toContainText('Conflict — mapping disabled until removed.');
  await expect(locations).toContainText('Conflicting maps are registered');
  await panel.getByRole('button', { name: 'Remove map source-map-example B' }).click();
  await expect(locations).toContainText('No map is registered');
  await register(panel, fixture.expected.B.manifest, fixture.expected.B.map);
  await expect(locations).toContainText('release-b.ts:7:3');

  await rows.nth(1).click();
  await expect(locations).toContainText('release-a.ts:2:3');
  await panel.getByRole('button', { name: 'Remove map source-map-example A' }).click();
  await expect(locations).toContainText('No map is registered');
  await register(panel, fixture.expected.A.manifest, fixture.expected.A.map);
  await expect(locations).toContainText('release-a.ts:2:3');
  await rows.nth(0).click();
  await expect(locations).toContainText('release-b.ts:7:3');
  expect(await receivedEvents()).toEqual(before);

  await page.getByRole('button', { name: 'Error Dashboard', exact: true }).first().click();
  await expect(page.locator('.dash-summary')).toContainText('2 events');
  await page.locator('.chart-top-errors button').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('region', { name: 'Original locations' })).toContainText('release-b.ts:7:3');
  await dialog.getByRole('button', { name: 'Close details' }).click();

  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save query data ↓' }).click();
  const exported = JSON.parse(await readFile(await (await pendingDownload).path(), 'utf8'));
  expect(exported.events).toHaveLength(2);
  expect(exported.events.map(event => event.eventId).sort()).toEqual([eventA.eventId, eventB.eventId].sort());
  expect(JSON.stringify(exported)).not.toMatch(/release-[ab]\.ts|private-fixture|private-fragment|sourceMap|mappings/);

  await page.reload();
  await page.locator('.language-switcher select').selectOption('en');
  await page.getByRole('button', { name: 'Event Timeline', exact: true }).last().click();
  await expect(page.locator('.event-row')).toHaveCount(2);
  await expect(page.locator('.detail-panel').getByRole('region', { name: 'Original locations' })).toContainText('No map is registered');

  await page.getByRole('button', { name: 'Error Dashboard', exact: true }).first().click();
  await page.getByLabel('Historical data JSON file').setInputFiles({
    name: 'events.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(page.locator('.dash-summary')).toContainText('2 events');
  await page.locator('.chart-top-errors button').first().click();
  await expect(page.getByRole('dialog').getByRole('region', { name: 'Original locations' })).toContainText('No map is registered');
  const dialogPanel = page.getByRole('dialog').locator('.source-map-panel');
  await dialogPanel.locator('summary').click();
  await register(dialogPanel, fixture.expected.B.manifest, fixture.expected.B.map);
  await expect(page.getByRole('dialog').getByRole('region', { name: 'Original locations' })).toContainText('release-b.ts:7:3');
  expect(requests.some(url => /\.map(?:[?#]|$)|release-[ab]\.ts/.test(url))).toBe(false);
});

test('registers two React releases through CI and resolves private source in the live viewer', async ({ page, browserName }) => {
  const liveScratch = await mkdtemp(join(tmpdir(), 'browser-source-map-registry-'));
  const livePort = await availablePort();
  const liveOrigin = `http://127.0.0.1:${livePort}`;
  const token = 'browser-fixture-source-map-token-0123456789';
  const password = 'browser-fixture-viewer-password';
  const basic = `Basic ${Buffer.from(`viewer:${password}`).toString('base64')}`;
  const livePublic = join(liveScratch, 'public');
  let liveCollector;
  try {
    await mkdir(join(livePublic, 'assets'), { recursive: true });
    await copyFile('dist/micro-server/public/index.html', join(livePublic, 'index.html'));
    await cp('dist/micro-server/public/assets', join(livePublic, 'assets'), { recursive: true });
    await writeFile(join(livePublic, 'react.html'), '<!doctype html><html><button id="fire">Trigger React error</button><div id="root"></div><script src="/assets/app.js?cache=private-fixture"></script></html>');

    const releases = {};
    for (const release of ['A', 'B']) {
      const output = join(liveScratch, release, 'assets');
      await mkdir(output, { recursive: true });
      const source = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { init } from '@ihyeon/browser-error-log';
import { ErrorBoundary } from '@ihyeon/browser-error-log-react';
const client = init({ project: 'source-map-example', environment: 'local', release: '${release}', endpoint: '/api/events', captureNetwork: false, flushIntervalMs: 50 });
function Broken${release}() { throw new Error('render failed ${release}'); /* private-source-${release} */ }
const root = createRoot(document.getElementById('root'));
document.getElementById('fire').addEventListener('click', () => root.render(<ErrorBoundary client={client} fallback={<p>Recovered</p>}><Broken${release} /></ErrorBoundary>));
window.__sourceMapFixtureClient = client;
window.__sourceMapFixtureReady = true;
`;
      await build({ stdin: { contents: source, sourcefile: `react-release-${release.toLowerCase()}.tsx`, resolveDir: process.cwd(), loader: 'tsx' },
        outfile: join(output, 'app.js'), bundle: true, minify: true, keepNames: release === 'A', sourcemap: 'external', sourcesContent: true,
        platform: 'browser', format: 'iife', target: 'es2020', jsx: 'transform',
        define: { 'process.env.NODE_ENV': JSON.stringify(release === 'A' ? 'development' : 'production') }, logLevel: 'silent' });
      const bundle = join(output, 'app.js');
      await writeFile(bundle, (await readFile(bundle, 'utf8')).replace(/\n\/\/# sourceMappingURL=.*$/u, '\n'));
      releases[release] = { bundle, buildDir: output };
    }

    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MICRO_')));
    liveCollector = spawn(process.execPath, [resolve('dist/micro-server/server.mjs')], {
      env: { ...environment, MICRO_HOST: '127.0.0.1', MICRO_PORT: String(livePort),
        MICRO_PROJECTS: 'source-map-example', MICRO_STORAGE: 'sqlite',
        MICRO_PUBLIC_DIR: livePublic, MICRO_DATA_DIR: join(liveScratch, 'data'),
        MICRO_VIEWER_PASSWORD: password, MICRO_SOURCE_MAP_TOKEN: token },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostics = '';
    liveCollector.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (liveCollector.exitCode !== null) throw new Error(`Collector exited: ${diagnostics}`);
      try { if ((await fetch(`${liveOrigin}/api/health`)).ok) break; } catch { /* waiting */ }
      if (attempt === 49) throw new Error(`Collector did not start: ${diagnostics}`);
      await delay(100);
    }

    for (const release of ['A', 'B']) {
      execFileSync(process.execPath, [resolve('scripts/register-source-maps.mjs'),
        '--build-dir', releases[release].buildDir, '--asset-base-url', `${liveOrigin}/assets/`,
        '--collector-url', liveOrigin, '--project', 'source-map-example', '--environment', 'local', '--release', release],
      { env: { ...process.env, BEL_SOURCE_MAP_TOKEN: token }, stdio: 'pipe' });
      const lookup = new URL(`${liveOrigin}/api/source-maps`);
      for (const [key, value] of Object.entries({ project: 'source-map-example', environment: 'local', release, assetUrl: `${liveOrigin}/assets/app.js` })) lookup.searchParams.set(key, value);
      const stored = await fetch(lookup, { headers: { authorization: basic } });
      expect(stored.status).toBe(200);
      expect((await stored.json()).manifest.release).toBe(release);
    }

    await page.context().setExtraHTTPHeaders({ authorization: basic });
    for (const release of ['A', 'B']) {
      await copyFile(releases[release].bundle, join(livePublic, 'assets', 'app.js'));
      await page.goto(`${liveOrigin}/react.html?release=${release}`);
      await page.waitForFunction(() => window.__sourceMapFixtureReady === true);
      await page.getByRole('button', { name: 'Trigger React error' }).click();
      await expect(page.getByText('Recovered')).toBeVisible();
      await page.evaluate(() => window.__sourceMapFixtureClient.flush());
      await expect.poll(async () => {
        const response = await fetch(`${liveOrigin}/api/events?project=source-map-example&environment=local`, { headers: { authorization: basic } });
        return (await response.json()).events.filter(event => event.release === release && event.type === 'react').length;
      }).toBe(1);
    }

    const response = await fetch(`${liveOrigin}/api/events?project=source-map-example&environment=local`, { headers: { authorization: basic } });
    const events = (await response.json()).events;
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.type).toBe('react');
      expect(event.componentStack).toContain('/assets/app.js');
      expect(event.stack).toMatch(/\/assets\/app\.js:\d+:\d+/);
      expect(event.componentStack).toMatch(/\/assets\/app\.js:\d+:\d+/);
      expect(JSON.stringify(event)).not.toMatch(/private-source-[AB]|cache=private-fixture/);
    }

    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto(liveOrigin);
    await page.locator('.language-switcher select').selectOption('en');
    await page.getByRole('button', { name: 'Event Timeline', exact: true }).last().click();
    await expect(page.locator('.event-row')).toHaveCount(2);
    const rows = page.locator('.event-row');
    for (const [index, release] of [[1, 'A'], [0, 'B']]) {
      await rows.nth(index).click();
      const inspector = page.locator('.detail-panel');
      await expect(inspector.getByText('Release', { exact: true }).locator('..')).toContainText(release);
      const locations = inspector.getByRole('region', { name: 'Original locations' });
      await expect(locations).toContainText('React component frames');
      const column = browserName === 'webkit' ? 32 : 28;
      const sourceLocation = `react-release-${release.toLowerCase()}.tsx:6:${column}`;
      const jsFrame = locations.locator('ol').first().locator('li').first();
      await expect(jsFrame).toContainText(`Original ${sourceLocation}`);
      const componentFrame = locations.locator('ol').nth(1).locator('li').first();
      await expect(componentFrame).toContainText(`Original ${sourceLocation}`);
      await componentFrame.getByRole('button', { name: 'View source' }).click();
      const excerpt = componentFrame.getByRole('region', { name: 'Original source excerpt' });
      await expect(excerpt).toContainText(`private-source-${release}`);
      await expect(excerpt.locator('.source-map-preview-target mark')).toBeVisible();
      await expect(excerpt.locator('.source-map-preview-target mark')).toHaveAttribute('aria-label', `Original column ${column}`);
    }
    expect(requests.filter(url => url.includes('/api/source-maps?')).length).toBeGreaterThan(0);
    expect(requests.some(url => /app\.js\.map|react-release-[ab]\.tsx/.test(url))).toBe(false);

    await page.getByRole('button', { name: 'Error Dashboard', exact: true }).first().click();
    await expect(page.locator('.dash-summary')).toContainText('2 events');
    await page.locator('.chart-top-errors button').first().click();
    await expect(page.getByRole('dialog').getByRole('region', { name: 'Original locations' })).toContainText('react-release-b.tsx');
    await page.getByRole('dialog').getByRole('button', { name: 'Close details' }).click();

    const pendingDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save query data ↓' }).click();
    const exported = JSON.parse(await readFile(await (await pendingDownload).path(), 'utf8'));
    expect(JSON.stringify(exported)).not.toMatch(/private-source-[AB]|mapBase64|sourceContents|sourcesContent/);
    const beforeImportLookupCount = requests.filter(url => url.includes('/api/source-maps?')).length;
    await page.getByLabel('Historical data JSON file').setInputFiles({
      name: 'events.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(page.locator('.dash-summary')).toContainText('2 events');
    await page.locator('.chart-top-errors button').first().click();
    await expect(page.getByRole('dialog').getByRole('region', { name: 'Original locations' })).toContainText('No map is registered');
    await delay(200);
    expect(requests.filter(url => url.includes('/api/source-maps?')).length).toBe(beforeImportLookupCount);
  } finally {
    if (liveCollector && liveCollector.exitCode === null && liveCollector.signalCode === null) {
      const closed = once(liveCollector, 'exit');
      liveCollector.kill('SIGTERM');
      const timeout = setTimeout(() => liveCollector.kill('SIGKILL'), 10_000);
      try { await closed; } finally { clearTimeout(timeout); }
    }
    await rm(liveScratch, { recursive: true, force: true });
  }
});
