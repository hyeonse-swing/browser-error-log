import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let directory: string;
const bundle = 'throw new Error("demo");\n';
const map = JSON.stringify({ version: 3, file: 'app.js', sources: ['src/cart.ts'], names: [], mappings: 'AAAA' }) + '\n';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'map manifest '));
  await writeFile(join(directory, 'app.js'), bundle);
  await writeFile(join(directory, 'app.js.map'), map);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function prepare(assetUrl = 'https://cdn.example/assets/app.js', release = 'build-a') {
  return spawnSync(process.execPath, ['scripts/prepare-source-map.mjs',
    '--project', 'shop', '--environment', 'production', '--release', release, '--url', assetUrl,
    '--bundle', join(directory, 'app.js'), '--map', join(directory, 'app.js.map'), '--out', join(directory, 'manifest.json'),
  ], { encoding: 'utf8' });
}

it('records hashes of the actual bundle and map bytes without embedding source or local paths', async () => {
  expect(prepare().status).toBe(0);
  expect(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).toEqual({
    schemaVersion: 1, project: 'shop', environment: 'production', release: 'build-a',
    assetUrl: 'https://cdn.example/assets/app.js', bundleSha256: digest(bundle), mapSha256: digest(map),
  });
  expect(prepare().status).not.toBe(0);
});

it('rejects uncertain identity, indexed maps and a map declaring a different bundle', async () => {
  expect(prepare(undefined, 'unknown').status).not.toBe(0);
  expect(prepare('https://cdn.example/assets/app.js?build=1').status).not.toBe(0);
  expect(prepare('https://name:pass@cdn.example/assets/app.js').status).not.toBe(0);
  await writeFile(join(directory, 'app.js.map'), '{"version":3,"sections":[]}');
  expect(prepare().status).not.toBe(0);
  await writeFile(join(directory, 'app.js.map'), map.replace('app.js', 'unrelated.js'));
  expect(prepare().status).not.toBe(0);
  await expect(readFile(join(directory, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('accepts a generated Unicode filename deployed under its encoded URL', async () => {
  await writeFile(join(directory, 'app.js.map'), map.replace('app.js', '앱.js'));
  expect(prepare('https://cdn.example/assets/%EC%95%B1.js').status).toBe(0);
});
