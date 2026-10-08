import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Install the actual package tarballs in an isolated consumer, without tsconfig aliases.
// Everything stays local; this script never publishes a package.
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'browser-error-log-package-check-'));
const out = resolve(root, 'output/packages');
mkdirSync(out, { recursive: true });
const npm = (args, cwd = root) => execFileSync('npm', [
  ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(scratch, 'cache'),
], { cwd, stdio: 'pipe', encoding: 'utf8' });
const pack = (args, destination) => JSON.parse(npm([
  'pack', ...args, '--json', '--pack-destination', destination,
])).map(pkg => join(destination, pkg.filename));
const createConsumer = name => {
  const directory = join(scratch, name);
  mkdirSync(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }));
  return directory;
};
const packages = ['browser-error-log-protocol', 'browser-error-log', 'browser-error-log-react'];
const tarballs = pack(packages.flatMap(p => ['--workspace', p]), out);

// Browser-only consumers must not need React or workspace TypeScript aliases.
const browserConsumer = createConsumer('browser-smoke');
npm(['install', ...tarballs.slice(0, 2)], browserConsumer);
execFileSync(process.execPath, ['--input-type=module', '-e', `
  import { createRequire } from 'node:module';
  import { init } from 'browser-error-log';
  const require = createRequire(import.meta.url);
  try { require.resolve('react'); throw new Error('Browser package unexpectedly requires React'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  const client = init({ project: 'ssr' }); await client.flush(); client.destroy();
`], { cwd: browserConsumer, stdio: 'inherit' });

// Repack installed peer/type dependencies, so the check needs neither registry
// access nor a previously warmed npm cache. npm ci is the only prerequisite.
const peers = pack(['react', '@types/react', 'csstype'].map(p => join(root, 'node_modules', p)), scratch);
const consumer = createConsumer('react-smoke');
npm(['install', ...tarballs, ...peers], consumer);
writeFileSync(join(consumer, 'consumer.tsx'), `import { init, type TransportContext } from 'browser-error-log';
import { ErrorBoundary } from 'browser-error-log-react';
import { EVENT_LABELS, type EventBatch } from 'browser-error-log-protocol';
const client = init({project:'consumer',enabled:false,transport:async(batch:EventBatch,context:TransportContext)=>{void batch;void context.signal;}});
client.captureException(new Error(EVENT_LABELS.manual));
const node = <ErrorBoundary client={client} fallback={<p>Fallback</p>}><p>Ready</p></ErrorBoundary>;
void node; client.destroy();`);
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--jsx', 'react-jsx', 'consumer.tsx'], { cwd: consumer, stdio: 'inherit' });
execFileSync(process.execPath, ['--input-type=module', '-e', `import {init} from 'browser-error-log'; import {ErrorBoundary} from 'browser-error-log-react'; if(typeof ErrorBoundary!=='function') throw new Error('adapter missing'); const c=init({project:'ssr'}); await c.flush(); c.destroy();`], { cwd: consumer, stdio: 'inherit' });
execFileSync(process.execPath, ['-e', `const {init}=require('browser-error-log');const {SCHEMA_VERSION}=require('browser-error-log-protocol');const {ErrorBoundary}=require('browser-error-log-react');if(SCHEMA_VERSION!==1||typeof ErrorBoundary!=='function')throw Error('exports invalid');init({project:'ssr'}).destroy();`], { cwd: consumer, stdio: 'inherit' });
console.log('Offline tarball install, browser without React, public TypeScript declarations, ESM/CJS and SSR smoke: PASS');
console.log(`SDK tarballs: ${out}`);
console.log(`Isolated consumer: ${consumer}`);
