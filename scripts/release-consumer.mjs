import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { REGISTRY, PACKAGES } from './release-common.mjs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Pass the published version to verify');
const scratch = mkdtempSync(join(tmpdir(), 'browser-error-log-registry-'));
const cache = join(scratch, 'npm-cache');
const root = fileURLToPath(new URL('..', import.meta.url));

function consumer(name, dependencies, expectedPackages, esm, cjs, typescript) {
  const dir = join(scratch, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, private: true, type: 'module' })}\n`);
  execFileSync('npm', ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
    '--prefer-online', '--registry', REGISTRY, '--cache', cache, ...dependencies], {
    cwd: dir, stdio: 'inherit',
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

consumer('browser-only', [
  `browser-error-log@${version}`,
], ['browser-error-log', 'browser-error-log-protocol'], `
  import { createRequire } from 'node:module';
  import { init } from 'browser-error-log';
  import { SDK_VERSION } from 'browser-error-log-protocol';
  if (SDK_VERSION !== '${version}') throw Error('Protocol version differs');
  const require = createRequire(import.meta.url);
  try { require.resolve('react'); throw Error('Browser-only install pulled React'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  const client = init({ project: 'registry-smoke' });
  await client.flush(); client.destroy();
`, `
  const { init } = require('browser-error-log');
  const { SDK_VERSION } = require('browser-error-log-protocol');
  if (SDK_VERSION !== '${version}') throw Error('Protocol CJS version differs');
  init({ project: 'registry-smoke' }).destroy();
`);

consumer('react', [
  `browser-error-log-react@${version}`, 'react@19.3.0', '@types/react@^19', 'csstype@^3',
], PACKAGES.map(pkg => pkg.name), `
  import { init } from 'browser-error-log';
  import { ErrorBoundary } from 'browser-error-log-react';
  if (typeof ErrorBoundary !== 'function') throw Error('React adapter ESM export missing');
  init({ project: 'registry-smoke' }).destroy();
`, `
  const { init } = require('browser-error-log');
  const { ErrorBoundary } = require('browser-error-log-react');
  if (typeof ErrorBoundary !== 'function') throw Error('React adapter CJS export missing');
  init({ project: 'registry-smoke' }).destroy();
`, `
  import { init, type TransportContext } from 'browser-error-log';
  import { ErrorBoundary } from 'browser-error-log-react';
  import { EVENT_LABELS, type EventBatch } from 'browser-error-log-protocol';
  const client = init({ project: 'registry-smoke', enabled: false,
    transport: async (batch: EventBatch, context: TransportContext) => { void batch; void context.signal; } });
  client.captureException(new Error(EVENT_LABELS.manual));
  const view = <ErrorBoundary client={client} fallback={<p>Fallback</p>}><p>Ready</p></ErrorBoundary>;
  void view; client.destroy();
`);

console.log(`Fresh npm registry consumer checks passed for ${version} (${scratch}).`);
