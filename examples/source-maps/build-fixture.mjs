import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TraceMap, generatedPositionFor, originalPositionFor } from '@jridgewell/trace-mapping';

const exampleDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(exampleDirectory, '../..');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const output = option('--output-dir');
const assetUrl = option('--asset-url') ?? 'https://app.example.test/assets/app.js';
assert((args.length === 2 || args.length === 4) && output && (args.length === 2 || option('--asset-url')),
  'Usage: node examples/source-maps/build-fixture.mjs --output-dir <directory> [--asset-url <http(s)://origin/assets/app.js>]');
const outputDirectory = resolve(output);
const expected = {};
const historyEvents = [];
await mkdir(dirname(outputDirectory), { recursive: true });
try { await mkdir(outputDirectory); }
catch (error) {
  if (error.code === 'EEXIST') throw new Error('The output directory already exists. Choose a new directory for this fixture run.');
  throw error;
}

for (const [release, file] of [['A', 'release-a.ts'], ['B', 'release-b.ts']]) {
  const source = await readFile(join(exampleDirectory, file), 'utf8');
  const sourceLines = source.split('\n');
  const line = sourceLines.findIndex(value => value.includes('SOURCE_MAP_FIXTURE_MISSING()')) + 1;
  assert(line > 0);
  const column = sourceLines[line - 1].indexOf('SOURCE_MAP_FIXTURE_MISSING') + 1;
  const directory = join(outputDirectory, release);
  const bundle = join(directory, 'assets', 'app.js');
  const map = `${bundle}.map`;
  const manifest = join(directory, 'manifest.json');
  await mkdir(join(directory, 'assets'), { recursive: true });
  await build({
    stdin: { contents: source, sourcefile: file, loader: 'ts' },
    outfile: bundle,
    bundle: true,
    minify: true,
    sourcemap: 'external',
    sourcesContent: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    logLevel: 'silent',
  });
  execFileSync(process.execPath, [join(repository, 'scripts', 'prepare-source-map.mjs'),
    '--project', 'source-map-example', '--environment', 'local', '--release', release,
    '--url', assetUrl, '--bundle', bundle, '--map', map, '--out', manifest],
  { cwd: repository, stdio: 'pipe' });
  const sourceMap = new TraceMap(JSON.parse(await readFile(map, 'utf8')));
  const generated = generatedPositionFor(sourceMap, { source: file, line, column: column - 1 });
  assert(generated.line !== null && generated.column !== null, 'The fixture error has no generated position.');
  const original = originalPositionFor(sourceMap, { line: generated.line, column: generated.column });
  assert(original.source === file && original.line === line && original.column === column - 1,
    'The fixture error position no longer maps to the authored expression.');
  historyEvents.push({
    schemaVersion: 1,
    eventId: `synthetic-source-map-${release}`,
    project: 'source-map-example',
    environment: 'local',
    release,
    sdkVersion: 'synthetic-fixture',
    occurredAt: `2026-11-19T08:00:0${release === 'A' ? '0' : '1'}.000Z`,
    viewId: `synthetic-view-${release}`,
    sequence: release === 'A' ? 1 : 2,
    elapsedMs: 0,
    type: 'javascript',
    message: `Synthetic release ${release}: unresolved identifier`,
    name: 'ReferenceError',
    stack: `ReferenceError: SOURCE_MAP_FIXTURE_MISSING is not defined\n    at crash (${assetUrl}:${generated.line}:${generated.column + 1})`,
    page: new URL('/source-map-example', assetUrl).href,
    runtime: 'browser',
    context: { synthetic: true },
  });
  expected[release] = { source: file, line, column, bundle, map, manifest };
}

const eventsFile = join(outputDirectory, 'events.json');
await writeFile(eventsFile, JSON.stringify({ schemaVersion: 1, events: historyEvents }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ assetUrl, eventsFile, expected }, null, 2));
