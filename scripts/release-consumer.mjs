import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { REGISTRY, PACKAGES } from './release-common.mjs';
import { retryRegistryInstall } from './release-install.mjs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Pass the published version to verify');
const scratch = mkdtempSync(join(tmpdir(), 'browser-error-log-registry-'));
const cache = join(scratch, 'npm-cache');
const root = fileURLToPath(new URL('..', import.meta.url));

async function consumer(name, dependencies, expectedPackages, esm, cjs, typescript) {
  const dir = join(scratch, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, private: true, type: 'module' })}\n`);
  await retryRegistryInstall({
    expectedPackages, version,
    sleep: ms => {
      console.log(`npm metadata is still propagating; retrying ${name} install in ${ms / 1000}s.`);
      return new Promise(resolve => setTimeout(resolve, ms));
    },
    install: () => {
      try {
        return execFileSync('npm', ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
          '--prefer-online', '--registry', REGISTRY, '--cache', cache, ...dependencies], {
          cwd: dir, stdio: ['inherit', 'inherit', 'pipe'],
        });
      } catch (error) {
        if (error.stderr) process.stderr.write(error.stderr);
        throw error;
      }
    },
  });
  for (const pkg of PACKAGES.filter(pkg => expectedPackages.includes(pkg.name))) {
    const installed = JSON.parse(readFileSync(join(dir, 'node_modules', pkg.name, 'package.json'), 'utf8'));
    if (installed.version !== version) throw new Error(`${name} installed ${pkg.name}@${installed.version}`);
  }
  execFileSync(process.execPath, ['--input-type=module', '-e', esm], { cwd: dir, stdio: 'inherit' });
  execFileSync(process.execPath, ['-e', cjs], { cwd: dir, stdio: 'inherit' });
  if (typescript) {
    writeFileSync(join(dir, 'consumer.tsx'), typescript);
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit',
      '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--jsx', 'react-jsx', 'consumer.tsx'], { cwd: dir, stdio: 'inherit' });
  }
}

await consumer('protocol-only', [`@ihyeon/browser-error-log-protocol@${version}`],
  ['@ihyeon/browser-error-log-protocol'], `
  import { createRequire } from 'node:module';
  import { SDK_VERSION, isBreadcrumbTrail, BREADCRUMB_LIMITS } from '@ihyeon/browser-error-log-protocol';
  if (!isBreadcrumbTrail([]) || BREADCRUMB_LIMITS.count !== 20) throw Error('Breadcrumb exports missing');
  if (SDK_VERSION !== '${version}') throw Error('Protocol version differs');
  const require = createRequire(import.meta.url);
  for (const name of ['@ihyeon/browser-error-log', '@ihyeon/browser-error-log-react', 'react']) {
    try { require.resolve(name); throw Error('Protocol-only install pulled ' + name); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
`, `
  const { SDK_VERSION } = require('@ihyeon/browser-error-log-protocol');
  if (SDK_VERSION !== '${version}') throw Error('Protocol CJS version differs');
`, `
  import { SCHEMA_VERSION, type EventBatch } from '@ihyeon/browser-error-log-protocol';
  const batch: EventBatch = { schemaVersion: SCHEMA_VERSION, events: [] }; void batch;
`);

await consumer('browser-only', [
  `@ihyeon/browser-error-log@${version}`,
], ['@ihyeon/browser-error-log', '@ihyeon/browser-error-log-protocol'], `
  import { createRequire } from 'node:module';
  import { init } from '@ihyeon/browser-error-log';
  import { SDK_VERSION } from '@ihyeon/browser-error-log-protocol';
  if (SDK_VERSION !== '${version}') throw Error('Protocol version differs');
  const require = createRequire(import.meta.url);
  try { require.resolve('react'); throw Error('Browser-only install pulled React'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  const client = init({ project: 'registry-smoke' });
  client.addBreadcrumb({ message: 'SSR no-op' }); client.clearBreadcrumbs();
  await client.flush(); client.destroy();
  const diagnostics = client.getDiagnostics();
  if (diagnostics.dropped !== 0 || diagnostics.inFlight !== 0 || diagnostics.filtered !== 0 || diagnostics.deduplicated !== 0
    || Object.values(diagnostics.droppedByReason).some(count => count !== 0)) throw Error('SSR diagnostics invalid');
`, `
  const { init } = require('@ihyeon/browser-error-log');
  const { SDK_VERSION } = require('@ihyeon/browser-error-log-protocol');
  if (SDK_VERSION !== '${version}') throw Error('Protocol CJS version differs');
  const client = init({ project: 'registry-smoke' });
  if (client.getDiagnostics().droppedByReason.rateLimit !== 0) throw Error('CJS diagnostics missing');
  client.destroy();
`);

await consumer('react', [
  `@ihyeon/browser-error-log-react@${version}`, 'react@19.3.0', '@types/react@^19', 'csstype@^3',
], PACKAGES.map(pkg => pkg.name), `
  import { init } from '@ihyeon/browser-error-log';
  import { ErrorBoundary } from '@ihyeon/browser-error-log-react';
  if (typeof ErrorBoundary !== 'function') throw Error('React adapter ESM export missing');
  init({ project: 'registry-smoke' }).destroy();
`, `
  const { init } = require('@ihyeon/browser-error-log');
  const { ErrorBoundary } = require('@ihyeon/browser-error-log-react');
  if (typeof ErrorBoundary !== 'function') throw Error('React adapter CJS export missing');
  init({ project: 'registry-smoke' }).destroy();
`, `
  import { init, type TransportContext, type BrowserErrorLogClient, type BrowserErrorLogBreadcrumbClient, type BrowserErrorLogDiagnosticsClient, type BrowserErrorLogDiagnostics, type BrowserErrorLogDropReason } from '@ihyeon/browser-error-log';
  import { ErrorBoundary } from '@ihyeon/browser-error-log-react';
  import { EVENT_LABELS, type EventBatch } from '@ihyeon/browser-error-log-protocol';
  const client = init({ project: 'registry-smoke', enabled: false, captureNavigation: true, captureNetworkBreadcrumbs: true, maxEventsPerMinute: 60,
    transport: async (batch: EventBatch, context: TransportContext) => { void batch; void context.signal; } });
  client.captureException(new Error(EVENT_LABELS.manual));
  client.addBreadcrumb({ category: 'action', message: 'Registry consumer', data: { attempt: 1 } }); client.clearBreadcrumbs();
  const oldClient: BrowserErrorLogClient = {captureException(){},flush:async()=>{},destroy(){},getStats:()=>({queued:0,sent:0,dropped:0})};
  const oldBreadcrumbClient: BrowserErrorLogBreadcrumbClient = {...oldClient,addBreadcrumb(){},clearBreadcrumbs(){}};
  const oldBreadcrumbView = <ErrorBoundary client={oldBreadcrumbClient}><p>Compatible breadcrumbs</p></ErrorBoundary>; void oldBreadcrumbView;
  const diagnosticClient: BrowserErrorLogDiagnosticsClient = client;
  const diagnostics: BrowserErrorLogDiagnostics = diagnosticClient.getDiagnostics();
  const reason: BrowserErrorLogDropReason = 'deliveryError'; void diagnostics.droppedByReason[reason];
  const compatible = <ErrorBoundary client={oldClient}><p>Compatible</p></ErrorBoundary>; void compatible;
  const view = <ErrorBoundary client={client} fallback={<p>Fallback</p>}><p>Ready</p></ErrorBoundary>;
  void view; client.destroy();
`);

console.log(`Fresh npm registry consumer checks passed for ${version} (${scratch}).`);
