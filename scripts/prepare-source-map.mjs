import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { MAX_MAP_BYTES, matchesGeneratedFile, parseSourceMapManifest } from '../apps/viewer/src/source-map-manifest.ts';

const usage = 'node scripts/prepare-source-map.mjs --project NAME --environment ENV --release ID --url ASSET_URL --bundle BUILD.js --map BUILD.js.map --out MANIFEST.json';
const fields = ['project', 'environment', 'release', 'url', 'bundle', 'map', 'out'];

async function prepare() {
  const options = Object.fromEntries(fields.map(field => [field, { type: 'string' }]));
  const { values } = parseArgs({ options: { ...options, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log(usage); return; }
  if (fields.some(field => values[field] === undefined || (field !== 'environment' && !values[field]))) {
    throw new Error(usage);
  }

  const bundle = await stat(values.bundle);
  const mapFile = await stat(values.map);
  if (!bundle.isFile() || !bundle.size || !mapFile.isFile() || mapFile.size > MAX_MAP_BYTES) {
    throw new Error('Select a nonempty JavaScript bundle and a regular .map file up to 8 MiB.');
  }
  const mapBytes = await readFile(values.map);
  if (mapBytes.byteLength > MAX_MAP_BYTES) throw new Error('The source map exceeds 8 MiB.');
  let map;
  try { map = JSON.parse(mapBytes.toString('utf8')); }
  catch { throw new Error('The source map must contain valid JSON.'); }
  if (map?.version !== 3 || 'sections' in map || typeof map.mappings !== 'string' ||
      !Array.isArray(map.sources) || !map.sources.every(source => source === null || typeof source === 'string')) {
    throw new Error('Select a regular version 3 source map with encoded mappings.');
  }

  const bundleHash = createHash('sha256');
  for await (const chunk of createReadStream(values.bundle)) bundleHash.update(chunk);
  let manifest;
  try {
    manifest = parseSourceMapManifest({
      schemaVersion: 1,
      project: values.project, environment: values.environment, release: values.release,
      assetUrl: values.url, bundleSha256: bundleHash.digest('hex'),
      mapSha256: createHash('sha256').update(mapBytes).digest('hex'),
    });
  } catch {
    throw new Error('Check the project, environment, explicit release, and full HTTP(S) asset URL without credentials, query, or fragment.');
  }
  // Hidden maps can omit file. When present, it names the deployed bundle.
  if (!matchesGeneratedFile(map.file, manifest.assetUrl)) {
    throw new Error('The generated filename declared by this map does not match the asset URL.');
  }
  await writeFile(values.out, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(`Created ${values.out}. In the viewer, register this manifest with the same .map file.`);
}

try { await prepare(); }
catch (error) {
  console.error(error.code === 'EEXIST' ? 'The manifest destination already exists. Choose a new output path.' : error.message);
  process.exitCode = 1;
}
