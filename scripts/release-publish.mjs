import { resolve } from 'node:path';
import {
  REPOSITORY, REGISTRY, PACKAGES, assertTarballsMatchManifest, assertVersions,
  git, packRelease, readTagManifest, run,
} from './release-common.mjs';
import { releaseRegistryState, waitForRegistryPackage } from './release-registry.mjs';

const tag = process.env.GITHUB_REF?.replace(/^refs\/tags\//, '');
if (process.env.GITHUB_REPOSITORY !== REPOSITORY || !/^v\d+\.\d+\.\d+$/.test(tag)
  || process.env.GITHUB_REF !== `refs/tags/${tag}`) {
  throw new Error('npm publishing requires an immutable version tag in this repository');
}

git(['fetch', '--tags', 'origin', 'main']);
const commit = git(['rev-parse', `refs/tags/${tag}^{commit}`]);
if (git(['rev-parse', 'HEAD']) !== commit) throw new Error('Checkout does not match the requested release tag');
git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);
if (tag !== `v${assertVersions()}`) throw new Error('Release tag and package versions differ');
if (git(['status', '--porcelain'])) throw new Error('Publishing requires a clean checkout');

const manifest = readTagManifest(tag);
const tarballs = packRelease(resolve('output/release'));
assertTarballsMatchManifest(tarballs, manifest);

// Check every existing version before publishing any package. A mismatched
// version is immutable on npm and must stop the entire release immediately.
const initial = await releaseRegistryState(manifest);
for (const pkg of PACKAGES) {
  if (!initial.missing.includes(pkg.name)) {
    console.log(`${pkg.name}@${manifest.version} already matches the tagged tarball; skip publish.`);
    continue;
  }
  console.log(`Publishing ${pkg.name}@${manifest.version} from ${tag}.`);
  run('npm', ['publish', tarballs[pkg.name].file, '--access', 'public', '--provenance',
    '--registry', REGISTRY, '--ignore-scripts']);
  await waitForRegistryPackage(pkg.name, manifest);
}
const finalState = await releaseRegistryState(manifest);
if (!finalState.complete) throw new Error(`Published release still missing: ${finalState.missing.join(', ')}`);

run('node', ['scripts/release-consumer.mjs', manifest.version]);
console.log(`${tag}: all three npm packages match the tag and fresh consumer checks passed.`);
