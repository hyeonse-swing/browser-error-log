import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REPOSITORY = 'hyeonse-swing/browser-error-log';
export const REGISTRY = 'https://registry.npmjs.org/';
// 0.1.2 was published before this repository had release tags. This commit is
// the verified 0.1.2 source; subsequent releases use their immutable tags.
export const UNTAGGED_BASELINE = '316ceecc8c10b45f84eda0d21833338f34559266';
export const PACKAGES = [
  { name: '@ihyeon/browser-error-log-protocol', path: 'packages/protocol' },
  { name: '@ihyeon/browser-error-log', path: 'packages/browser' },
  { name: '@ihyeon/browser-error-log-react', path: 'packages/react' },
];
// Existing release tags retain their original npm identities and integrity.
export const LEGACY_PACKAGE_NAMES = ['browser-error-log-protocol', 'browser-error-log', 'browser-error-log-react'];
const versionFiles = ['package.json', 'apps/viewer/package.json', ...PACKAGES.map(pkg => `${pkg.path}/package.json`)];

export function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();
}

export function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

export function isReleaseRelevantPath(path) {
  return PACKAGES.some(pkg => path.startsWith(`${pkg.path}/`))
    || ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
      'scripts/build-sdk.mjs', 'scripts/verify-package.mjs',
      '.github/workflows/prepare.yml', '.github/workflows/publish.yml'].includes(path)
    || /^scripts\/release[^/]*\.mjs$/.test(path);
}

export function nextVersion(version, bump = 'patch') {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || !['patch', 'minor', 'major'].includes(bump)) {
    throw new Error(`Invalid version or bump: ${version} (${bump})`);
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`Invalid version: ${version}`);
  const next = bump === 'major' ? [major + 1, 0, 0]
    : bump === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1];
  if (!next.every(Number.isSafeInteger)) throw new Error(`Version overflow: ${version} (${bump})`);
  return next.join('.');
}

export const nextPatch = version => nextVersion(version, 'patch');

export function selectReleaseBump(eventName, input, attempt = '1') {
  if (eventName !== 'workflow_dispatch') return 'patch';
  const bump = input ?? 'patch';
  if (!['patch', 'minor', 'major'].includes(bump)) throw new Error(`Invalid manual release bump: ${bump}`);
  if (bump !== 'patch' && String(attempt) !== '1') {
    throw new Error(`Manual ${bump} request cannot be rerun; inspect or resume the existing publisher, or start a new workflow_dispatch for an intentional bump.`);
  }
  return bump;
}

export function rejectUnappliedManualBump(bump, reason) {
  if (bump !== 'patch') throw new Error(`Manual ${bump} request was not applied: ${reason}; rerun the request.`);
}

export function isStalePush(eventName, eventSha, remoteSha, localSha) {
  return localSha !== remoteSha || (eventName === 'push' && eventSha !== remoteSha);
}

export function decideRelease({ tagExists, published, paths, bump = 'patch' }) {
  if (tagExists && !published) return 'resume';
  return bump !== 'patch' || paths.some(isReleaseRelevantPath) ? 'bump' : 'skip';
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function assertVersions(root = '.') {
  const read = path => readJson(resolve(root, path));
  const workspace = read('package.json');
  const version = workspace.version;
  if (workspace.private !== true || read('apps/viewer/package.json').private !== true) {
    throw new Error('Root and viewer workspaces must remain private');
  }
  for (const path of versionFiles) {
    if (read(path).version !== version) throw new Error(`${path} version differs from ${version}`);
  }
  for (const pkg of PACKAGES) {
    const data = read(`${pkg.path}/package.json`);
    if (data.name !== pkg.name || data.private === true || data.publishConfig?.access !== 'public'
      || data.publishConfig.registry !== REGISTRY) {
      throw new Error(`${pkg.path} public npm package identity/configuration differs`);
    }
  }
  if (read('packages/browser/package.json').dependencies['@ihyeon/browser-error-log-protocol'] !== version
    || read('packages/react/package.json').dependencies['@ihyeon/browser-error-log'] !== version) {
    throw new Error('Published package dependency pins differ from the workspace version');
  }
  const lock = read('package-lock.json');
  if (lock.version !== version) throw new Error('package-lock.json version differs');
  for (const path of ['', 'apps/viewer', ...PACKAGES.map(pkg => pkg.path)]) {
    if (lock.packages[path]?.version !== version) throw new Error(`Lockfile ${path || 'root'} version differs`);
  }
  if (lock.packages['packages/browser'].dependencies['@ihyeon/browser-error-log-protocol'] !== version
    || lock.packages['packages/react'].dependencies['@ihyeon/browser-error-log'] !== version) {
    throw new Error('Lockfile package dependency pins differ');
  }
  const browser = readFileSync(resolve(root, 'packages/browser/src/index.ts'), 'utf8');
  const protocol = readFileSync(resolve(root, 'packages/protocol/src/index.ts'), 'utf8');
  if (!browser.includes(`sdkVersion: '${version}'`) || !protocol.includes(`export const SDK_VERSION = '${version}'`)) {
    throw new Error('SDK runtime version literals differ');
  }
  for (const path of ['packages/protocol/README.md', 'packages/protocol/README.ko.md']) {
    if (!readFileSync(resolve(root, path), 'utf8').includes(`ihyeon-browser-error-log-protocol-${version}.tgz`)) {
      throw new Error(`${path} source tarball example differs from ${version}`);
    }
  }
  return version;
}

function replaceExactlyOnce(source, pattern, replacement, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, 'g'))];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label}; found ${matches.length}`);
  return source.replace(pattern, replacement);
}

export function setVersion(next, root = '.', bump = 'patch') {
  const previous = assertVersions(root);
  if (nextVersion(previous, bump) !== next) {
    throw new Error(`Only a single ${bump} bump is allowed: ${previous} -> ${next}`);
  }
  for (const path of versionFiles) {
    const file = resolve(root, path);
    const data = readJson(file);
    data.version = next;
    if (path === 'packages/browser/package.json') data.dependencies['@ihyeon/browser-error-log-protocol'] = next;
    if (path === 'packages/react/package.json') data.dependencies['@ihyeon/browser-error-log'] = next;
    writeJson(file, data);
  }
  const lockPath = resolve(root, 'package-lock.json');
  const lock = readJson(lockPath);
  lock.version = next;
  for (const path of ['', 'apps/viewer', ...PACKAGES.map(pkg => pkg.path)]) lock.packages[path].version = next;
  lock.packages['packages/browser'].dependencies['@ihyeon/browser-error-log-protocol'] = next;
  lock.packages['packages/react'].dependencies['@ihyeon/browser-error-log'] = next;
  writeJson(lockPath, lock);
  const literals = [
    ['packages/browser/src/index.ts', /sdkVersion: '\d+\.\d+\.\d+'/, `sdkVersion: '${next}'`, 'browser SDK version'],
    ['packages/protocol/src/index.ts', /export const SDK_VERSION = '\d+\.\d+\.\d+'/, `export const SDK_VERSION = '${next}'`, 'protocol SDK version'],
  ];
  for (const [path, pattern, replacement, label] of literals) {
    const file = resolve(root, path);
    writeFileSync(file, replaceExactlyOnce(readFileSync(file, 'utf8'), pattern, replacement, label));
  }
  for (const path of ['packages/protocol/README.md', 'packages/protocol/README.ko.md']) {
    const file = resolve(root, path);
    writeFileSync(file, replaceExactlyOnce(readFileSync(file, 'utf8'),
      /ihyeon-browser-error-log-protocol-\d+\.\d+\.\d+\.tgz/,
      `ihyeon-browser-error-log-protocol-${next}.tgz`, `${path} tarball example`));
  }
  assertVersions(root);
}

export function packRelease(directory) {
  mkdirSync(directory, { recursive: true });
  const tarballs = {};
  for (const pkg of PACKAGES) {
    const result = JSON.parse(execFileSync('npm', [
      'pack', '--workspace', pkg.name, '--json', '--pack-destination', directory,
      '--ignore-scripts', '--offline', '--update-notifier=false',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    if (result.length !== 1 || result[0].name !== pkg.name) throw new Error(`Unexpected npm pack result for ${pkg.name}`);
    const file = resolve(directory, result[0].filename);
    tarballs[pkg.name] = {
      file,
      integrity: `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`,
    };
  }
  return tarballs;
}

export function createTagManifest(version, tarballs) {
  return {
    version,
    packages: Object.fromEntries(PACKAGES.map(pkg => [pkg.name, tarballs[pkg.name].integrity])),
  };
}

export function manifestPackageNames(manifest) {
  const names = Object.keys(manifest.packages ?? {});
  const expected = [PACKAGES.map(pkg => pkg.name), LEGACY_PACKAGE_NAMES]
    .find(group => names.length === group.length && group.every(name => names.includes(name)));
  if (!expected) throw new Error('Release manifest has an invalid package identity set');
  for (const name of expected) {
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.packages[name])) {
      throw new Error(`Release manifest has no valid integrity for ${name}`);
    }
  }
  return expected;
}

export function readTagManifest(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
  if (git(['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') throw new Error(`${tag} must be an annotated tag`);
  const manifest = JSON.parse(git(['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`]));
  if (manifest.version !== tag.slice(1)) throw new Error(`${tag} manifest version differs`);
  manifestPackageNames(manifest);
  return manifest;
}

export function assertTarballsMatchManifest(tarballs, manifest) {
  for (const pkg of PACKAGES) {
    if (tarballs[pkg.name]?.integrity !== manifest.packages[pkg.name]) {
      throw new Error(`${pkg.name}@${manifest.version} tarball differs from the immutable release tag`);
    }
  }
}
