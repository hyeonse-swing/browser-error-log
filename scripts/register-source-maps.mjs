import { readdir, lstat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createSourceMapManifest } from './prepare-source-map.mjs';

const usage = 'node scripts/register-source-maps.mjs --build-dir dist --asset-base-url https://app.example/assets/ --collector-url https://collector.example --project NAME --environment ENV --release ID';
const required = ['build-dir', 'asset-base-url', 'collector-url', 'project', 'environment', 'release'];

function checkedUrl(value, name, originOnly = false) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must be a full HTTP(S) URL`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash ||
      (originOnly && value !== url.origin && value !== url.origin + '/') ||
      (!originOnly && !url.pathname.endsWith('/'))) {
    throw new Error(`${name} requires HTTPS (HTTP only for loopback), no credentials or query, and ${originOnly ? 'an exact origin' : 'a trailing slash'}`);
  }
  return url;
}

async function mapPaths(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Build directory must be a regular directory');
  const paths = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const pathname = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Build directory must not contain symlinks');
      if (entry.isDirectory()) await visit(pathname);
      else if (/\.[cm]?js\.map$/.test(entry.name)) {
        if (!entry.isFile()) throw new Error('Source map must be a regular file');
        paths.push(pathname);
      }
    }
  }
  await visit(directory);
  paths.sort();
  if (paths.length < 1 || paths.length > 32) throw new Error('Build directory must contain 1 to 32 JavaScript source maps');
  return paths;
}

export async function registerBuildMaps(values, { fetchImpl = fetch, token = process.env.BEL_SOURCE_MAP_TOKEN } = {}) {
  const buildDir = resolve(values['build-dir']);
  const assetBase = checkedUrl(values['asset-base-url'], 'Asset base URL');
  const collector = checkedUrl(values['collector-url'], 'Collector URL', true);
  if (!token || !/^[\x21-\x7e]{32,256}$/.test(token)) {
    throw new Error('BEL_SOURCE_MAP_TOKEN must contain 32 to 256 printable non-space characters');
  }

  // Check every bundle/map pairing and compute its hashes before uploading.
  // The collector validates and commits each map independently.
  const prepared = [];
  for (const mapPath of await mapPaths(buildDir)) {
    const bundlePath = mapPath.slice(0, -4);
    const bundle = await lstat(bundlePath);
    if (!bundle.isFile()) throw new Error('Every source map needs a regular matching JavaScript file');
    const assetPath = relative(buildDir, bundlePath).split(sep).map(encodeURIComponent).join('/');
    const url = new URL(assetPath, assetBase).href;
    const { manifest, mapBytes } = await createSourceMapManifest({
      project: values.project, environment: values.environment, release: values.release,
      url, bundle: bundlePath, map: mapPath,
    });
    prepared.push({ manifest, mapBase64: mapBytes.toString('base64') });
  }

  for (const { manifest, mapBase64 } of prepared) {
    let response;
    try {
      response = await fetchImpl(new URL('/api/source-maps', collector), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ manifest, mapBase64 }),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`Source map registration request failed for ${manifest.assetUrl}`);
    }
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`Collector returned HTTP ${response.status} for ${manifest.assetUrl}`);
    }
    const expected = response.status === 201 ? 'created' : 'duplicate';
    const isJson = /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
    const receipt = isJson ? await response.json().catch(() => null) : null;
    if (receipt?.status !== expected) throw new Error(`Collector did not confirm registration for ${manifest.assetUrl}`);
    console.log(`Registered ${manifest.assetUrl}`);
  }
  return prepared.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = Object.fromEntries(required.map(field => [field, { type: 'string' }]));
    const { values } = parseArgs({ options: { ...options, help: { type: 'boolean', short: 'h' } } });
    if (values.help) console.log(usage);
    else {
      if (required.some(field => values[field] === undefined)) throw new Error(usage);
      const count = await registerBuildMaps(values);
      console.log(`Registered ${count} release source map${count === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Source map registration failed');
    process.exitCode = 1;
  }
}
