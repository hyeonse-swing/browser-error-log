import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

// Usage: node scripts/benchmark-sdk-presets.mjs --sdk-dir <installed package>
//   --out output/preset-benchmark --repetitions 12
// Dedicated, sequential browsers; no SDK source change, network service, or publication.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) {
    assert(value.startsWith('--') && all[index + 1], `Expected --option value: ${value}`);
    pairs.push([value.slice(2), all[index + 1]]);
  }
  return pairs;
}, []));
assert(args['sdk-dir'], '--sdk-dir must point to a separately installed public package');
const repetitions = Number(args.repetitions ?? 12);
assert(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 100);
const output = resolve(args.out ?? resolve(root, 'output/preset-benchmark'));
const sdkDir = resolve(args['sdk-dir']);
const sdk = await readFile(resolve(sdkDir, 'dist/index.js'));
const pkg = JSON.parse(await readFile(resolve(sdkDir, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@ihyeon/browser-error-log');
assert.equal(pkg.version, '0.2.13');
const fixture = await readFile(resolve(root, 'scripts/fixtures/sdk-preset-benchmark.js'));
await mkdir(output, { recursive: true });
const modes = ['none', 'minimal', 'standard', 'detailed'];
const scenarios = {
  manual: { batches: 25, unitsPerBatch: 40, warmupBatches: 5, memoryUnits: 40 },
  healthy: { batches: 20, unitsPerBatch: 10, warmupBatches: 4, memoryUnits: 10 },
  mixed: { batches: 20, unitsPerBatch: 10, warmupBatches: 4, memoryUnits: 10 },
};
let collector;
function resetCollector() {
  collector = { requests: 0, bodyBytes: 0, events: 0, types: {}, versions: new Set(), withStack: 0, withComponentStack: 0, withBreadcrumbs: 0, maximumBatch: 0 };
}
resetCollector();
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  if (pathname === '/collector' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const batch = JSON.parse(body.toString('utf8'));
    collector.requests++;
    collector.bodyBytes += body.byteLength;
    collector.maximumBatch = Math.max(collector.maximumBatch, batch.events.length);
    for (const event of batch.events) {
      collector.events++;
      collector.types[event.type] = (collector.types[event.type] ?? 0) + 1;
      collector.versions.add(event.sdkVersion);
      collector.withStack += Boolean(event.stack);
      collector.withComponentStack += Boolean(event.componentStack);
      collector.withBreadcrumbs += Boolean(event.breadcrumbs?.length);
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return;
  }
  if (pathname === '/sdk.js') { res.setHeader('content-type', 'text/javascript'); res.end(sdk); return; }
  if (pathname === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(fixture); return; }
  if (pathname === '/ok' || pathname === '/fail') {
    res.writeHead(pathname === '/ok' ? 200 : 500, { 'content-type': 'text/plain' }); res.end('fixture'); return;
  }
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html lang="en"><title>SDK preset benchmark</title><h1>Synthetic SDK preset benchmark</h1><script type="module" src="/fixture.js"></script></html>');
});
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
const origin = `http://127.0.0.1:${server.address().port}`;
const rows = [];
const metadata = {
  startedAt: new Date().toISOString(),
  sdk: { name: pkg.name, version: pkg.version, esmSha256: createHash('sha256').update(sdk).digest('hex'), esmBytes: sdk.byteLength, esmGzipBytes: gzipSync(sdk).byteLength },
  harnessSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
  machine: { platform: platform(), release: release(), cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version },
  repetitions, scenarios, modes,
  browser: { headless: true, viewport: { width: 1280, height: 800 }, version: null },
  measurements: {
    cpu: 'CDP Performance timeDomain=threadTicks; TaskDuration, ScriptDuration, ThreadTime deltas. Workload includes explicit flush and HTTP completion; forced GC excluded.',
    memory: 'Separate post-warmup phase: no active client -> initialized -> one unflushed batch -> flushed. Full GC before each JS usedSize reading; RSS is summed renderer process RSS from ps, not SDK-owned memory or peak.',
    traffic: 'Actual uncompressed collector HTTP request-body bytes only; excludes headers/TCP/TLS, SDK download and fixture /ok,/fail requests.',
    order: 'Four-mode balanced Latin-square rotation by repetition, scenario order rotated by repetition. Fresh browser process for every cell. One 20%-sized warmup in the same page, discarded.',
    options: { flushIntervalMs: 60000, otherOptions: 'Defaults; capture flags, sampling, dedupe and limits not overridden.' },
    limitations: ['Synthetic local workload, not a production CPU percentage or a device-wide measurement.', 'No CPU/network throttling; host is shared with other apps.', 'Forced-GC retained heap is not allocation rate or peak memory.', 'Console strings and browser networking have their own costs, included in the SDK-absent control.'],
  },
};

function metricMap(response) { return Object.fromEntries(response.metrics.map(m => [m.name, m.value])); }
async function processStats(browserCdp) {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
  return processInfo.filter(p => p.type === 'renderer').sort((a, b) => a.id - b.id);
}
function rendererRss(processes) {
  const rss = execFileSync('ps', ['-p', processes.map(p => p.id).join(','), '-o', 'rss='], { encoding: 'utf8' });
  return rss.trim().split(/\s+/).reduce((sum, value) => sum + Number(value) * 1024, 0);
}
async function retainedMemory(cdp, browserCdp) {
  await cdp.send('Runtime.discardConsoleEntries');
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const processes = await processStats(browserCdp);
  return { jsHeapBytes: heap.usedSize, backingStorageBytes: heap.backingStorageSize, rendererRssBytes: rendererRss(processes) };
}
function expectedTypes(mode, scenario, units) {
  if (mode === 'none' || scenario === 'healthy') return {};
  if (scenario === 'manual' || mode === 'minimal') return { manual: units };
  return { manual: units, javascript: units, http: units, ...(mode === 'detailed' ? { console: units } : {}) };
}
function validate(mode, scenario, units, diagnostics) {
  const expected = expectedTypes(mode, scenario, units);
  assert.deepEqual(collector.types, expected, `${mode}/${scenario} types`);
  assert.equal(collector.events, Object.values(expected).reduce((s, n) => s + n, 0));
  assert.equal(diagnostics.sent, collector.events);
  for (const key of ['queued', 'inFlight', 'dropped', 'filtered', 'deduplicated']) assert.equal(diagnostics[key], 0, `${mode}/${scenario}/${key}`);
  assert(collector.maximumBatch <= 20);
  if (collector.events) assert.deepEqual([...collector.versions], ['0.2.13']);
  if (mode === 'minimal') { assert.equal(collector.withStack, 0); assert.equal(collector.withComponentStack, 0); }
  return { ...collector, versions: [...collector.versions], diagnostics };
}

let activeBrowser;
try {
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const names = Object.keys(scenarios);
    const scenarioOrder = names.map((_, i) => names[(i + repetition) % names.length]);
    // A Williams-style sequence balances which mode precedes another.
    const rotation = [0, 1, 3, 2];
    const modeOrder = rotation.map(index => modes[(index + repetition) % modes.length]);
    for (const scenario of scenarioOrder) for (const mode of modeOrder) {
      const spec = scenarios[scenario];
      activeBrowser = await chromium.launch({ headless: true });
      metadata.browser.version = activeBrowser.version();
      const page = await activeBrowser.newPage({ viewport: metadata.browser.viewport });
      const cdp = await page.context().newCDPSession(page);
      const browserCdp = await activeBrowser.newBrowserCDPSession();
      await page.goto(`${origin}/bench`);
      await page.waitForFunction(() => Boolean(window.benchmark));
      await page.evaluate(mode => window.benchmark.setup(mode), mode);
      await page.evaluate(config => window.benchmark.workload(config), { scenario, batches: spec.warmupBatches, unitsPerBatch: spec.unitsPerBatch });
      await page.evaluate(() => { window.benchmark.recreate(); performance.clearResourceTimings(); });
      await cdp.send('Runtime.discardConsoleEntries');
      await cdp.send('HeapProfiler.collectGarbage');
      resetCollector();
      await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
      const processesBefore = await processStats(browserCdp);
      const before = metricMap(await cdp.send('Performance.getMetrics'));
      const started = performance.now();
      const diagnostics = await page.evaluate(config => window.benchmark.workload(config), { scenario, batches: spec.batches, unitsPerBatch: spec.unitsPerBatch });
      const wallMs = performance.now() - started;
      const after = metricMap(await cdp.send('Performance.getMetrics'));
      const processesAfter = await processStats(browserCdp);
      assert.deepEqual(processesAfter.map(p => p.id), processesBefore.map(p => p.id), 'Renderer identity stable');
      const cpu = {
        taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
        scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
        threadMs: (after.ThreadTime - before.ThreadTime) * 1000,
        rendererCpuMs: (processesAfter.reduce((s, p) => s + p.cpuTime, 0) - processesBefore.reduce((s, p) => s + p.cpuTime, 0)) * 1000,
        wallMs,
      };
      for (const [name, value] of Object.entries(cpu)) assert(Number.isFinite(value), `Finite CPU metric: ${name}`);
      assert(cpu.taskMs > 0 && cpu.threadMs > 0 && cpu.rendererCpuMs > 0, 'CPU clocks available');
      const traffic = validate(mode, scenario, spec.batches * spec.unitsPerBatch, diagnostics);

      // Do not include forced collection or ps/CDP sampling in timed workload.
      await cdp.send('Performance.disable');
      await page.evaluate(() => { window.benchmark.destroy(); performance.clearResourceTimings(); });
      const bare = await retainedMemory(cdp, browserCdp);
      await page.evaluate(() => window.benchmark.recreate());
      const initialized = await retainedMemory(cdp, browserCdp);
      resetCollector();
      const queuedDiagnostics = await page.evaluate(config => window.benchmark.workload(config), { scenario, batches: 1, unitsPerBatch: spec.memoryUnits, flush: false });
      const queued = await retainedMemory(cdp, browserCdp);
      const expectedQueued = Object.values(expectedTypes(mode, scenario, spec.memoryUnits)).reduce((s, n) => s + n, 0);
      assert.equal(queuedDiagnostics.queued, expectedQueued);
      assert.equal(queuedDiagnostics.inFlight, 0);
      assert.equal(collector.events, 0, 'No implicit flush before queued memory snapshot');
      const flushedDiagnostics = await page.evaluate(() => window.benchmark.flush());
      validate(mode, scenario, spec.memoryUnits, flushedDiagnostics);
      const flushed = await retainedMemory(cdp, browserCdp);
      rows.push({ repetition, scenario, mode, cpu, traffic, memory: {
        bare, initialized, queued, flushed, queuedEvents: expectedQueued,
        clientHeapDeltaBytes: initialized.jsHeapBytes - bare.jsHeapBytes,
        queueHeapDeltaBytes: queued.jsHeapBytes - initialized.jsHeapBytes,
        postFlushHeapDeltaBytes: flushed.jsHeapBytes - initialized.jsHeapBytes,
      } });
      await activeBrowser.close(); activeBrowser = undefined;
      await writeFile(resolve(output, 'raw.json'), JSON.stringify({ metadata, rows }, null, 2) + '\n');
      console.log(JSON.stringify({ trial: `${repetition + 1}/${repetitions}`, scenario, mode, taskMs: +cpu.taskMs.toFixed(2), bodyBytes: traffic.bodyBytes, queueKiB: +((queued.jsHeapBytes - initialized.jsHeapBytes) / 1024).toFixed(2) }));
    }
  }
} finally {
  await activeBrowser?.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}
const median = values => quantile(values, 0.5);
function describe(values) {
  return { n: values.length, median: median(values), q1: quantile(values, 0.25), q3: quantile(values, 0.75), min: Math.min(...values), max: Math.max(...values) };
}
const fields = {
  taskMs: r => r.cpu.taskMs, scriptMs: r => r.cpu.scriptMs, threadMs: r => r.cpu.threadMs, rendererCpuMs: r => r.cpu.rendererCpuMs,
  wallMs: r => r.cpu.wallMs, bodyBytes: r => r.traffic.bodyBytes, requests: r => r.traffic.requests, events: r => r.traffic.events,
  clientHeapDeltaBytes: r => r.memory.clientHeapDeltaBytes, queueHeapDeltaBytes: r => r.memory.queueHeapDeltaBytes,
  initializedHeapBytes: r => r.memory.initialized.jsHeapBytes, queuedHeapBytes: r => r.memory.queued.jsHeapBytes,
  postFlushHeapDeltaBytes: r => r.memory.postFlushHeapDeltaBytes, queuedRssBytes: r => r.memory.queued.rendererRssBytes,
};
let randomState = 20261117;
function random() { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 2 ** 32; }
function reduction(minimal, comparison) {
  const ratio = (a, b) => median(b) === 0 ? null : 100 * (1 - median(a) / median(b));
  const estimate = ratio(minimal, comparison);
  if (estimate === null) return { estimatePercent: null, pairedBootstrap95: null };
  const draws = Array.from({ length: 3000 }, () => {
    const indices = Array.from({ length: minimal.length }, () => Math.floor(random() * minimal.length));
    return ratio(indices.map(i => minimal[i]), indices.map(i => comparison[i]));
  });
  return { estimatePercent: estimate, pairedBootstrap95: [quantile(draws, 0.025), quantile(draws, 0.975)] };
}
const summary = {};
for (const scenario of Object.keys(scenarios)) {
  summary[scenario] = { modes: {}, minimalReduction: {} };
  for (const mode of modes) {
    const selected = rows.filter(r => r.scenario === scenario && r.mode === mode);
    summary[scenario].modes[mode] = Object.fromEntries(Object.entries(fields).map(([key, get]) => [key, describe(selected.map(get))]));
  }
  for (const comparison of ['standard', 'detailed']) {
    const select = mode => rows.filter(r => r.scenario === scenario && r.mode === mode).sort((a, b) => a.repetition - b.repetition);
    // Full renderer RSS includes the browser runtime; do not label it SDK savings.
    summary[scenario].minimalReduction[comparison] = Object.fromEntries(['taskMs', 'bodyBytes', 'queueHeapDeltaBytes'].map(key => [key, reduction(select('minimal').map(fields[key]), select(comparison).map(fields[key]))]));
  }
}
metadata.finishedAt = new Date().toISOString();
await writeFile(resolve(output, 'raw.json'), JSON.stringify({ metadata, rows }, null, 2) + '\n');
await writeFile(resolve(output, 'summary.json'), JSON.stringify({ metadata, summary }, null, 2) + '\n');
console.log(`PASS: ${rows.length} measured cells; event counts, no drops, public SDK version, and memory snapshot boundaries verified. ${output}`);
