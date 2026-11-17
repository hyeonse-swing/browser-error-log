import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'skills/browser-error-log', 'docs/ai.md', 'llms.txt',
  'docs/preset-performance-2026-11-17.ko.md', 'docs/benchmarks/2026-11-17-presets',
  'scripts/benchmark-sdk-presets.mjs', 'scripts/fixtures/sdk-preset-benchmark.js',
];
async function filesUnder(dir) {
  const paths = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await filesUnder(path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`AI bundle source must be a regular file: ${path}`);
  }
  return paths.sort();
}

for (const name of ['browser', 'react', 'protocol']) {
  const pkg = JSON.parse(await readFile(resolve(root, `packages/${name}/package.json`), 'utf8'));
  const destination = resolve(root, `packages/${name}/ai`);
  await rm(destination, { recursive: true, force: true });
  for (const source of sources) {
    await mkdir(dirname(resolve(destination, source)), { recursive: true });
    await cp(resolve(root, source), resolve(destination, source), { recursive: true });
  }
  const files = {};
  for (const file of await filesUnder(destination)) {
    files[relative(destination, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify({ schemaVersion: 1, package: { name: pkg.name, version: pkg.version }, benchmarkSdkVersion: '0.2.13', files }, null, 2) + '\n');
}
console.log('Portable AI guides, skills, and measured performance evidence prepared for all three npm packages.');
