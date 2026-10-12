import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PACKAGES, assertTarballsMatchManifest, assertVersions, decideRelease,
  isReleaseRelevantPath, isStalePush, nextPatch, readTagManifest, setVersion,
} from './release-common.mjs';
import {
  lookupExactVersion, releaseAdvanceState, releaseRegistryState, waitForRegistryPackage,
} from './release-registry.mjs';
import { isSuccessfulTaggedPublishRun, verifiedPublishAttempt } from './release-github.mjs';

test('docs-only changes skip; packed package docs and release inputs trigger', () => {
  for (const path of ['README.md', 'docs/releasing.md', 'docs/ko/releasing.md', 'apps/viewer/src/App.tsx']) {
    assert.equal(isReleaseRelevantPath(path), false, path);
  }
  for (const path of ['packages/browser/src/index.ts', 'packages/react/README.ko.md',
    'scripts/build-sdk.mjs', 'scripts/release-publish.mjs', '.github/workflows/publish.yml']) {
    assert.equal(isReleaseRelevantPath(path), true, path);
  }
  assert.equal(decideRelease({ tagExists: false, published: true, paths: ['README.md'] }), 'skip');
  assert.equal(decideRelease({ tagExists: true, published: true, paths: ['packages/browser/src/index.ts'] }), 'bump');
  assert.equal(decideRelease({ tagExists: true, published: false, paths: ['packages/browser/src/index.ts'] }), 'resume');
});

test('stale main events cannot reserve a release version', () => {
  assert.equal(isStalePush('push', 'old', 'new', 'new'), true);
  assert.equal(isStalePush('push', 'new', 'new', 'old'), true);
  assert.equal(isStalePush('push', 'new', 'new', 'new'), false);
  assert.equal(isStalePush('workflow_dispatch', 'old', 'new', 'new'), false);
});

test('one patch bump synchronizes manifests, lockfile, pins and runtime literals', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'browser-error-log-version-'));
  const files = [
    'package.json', 'package-lock.json', 'apps/viewer/package.json',
    ...PACKAGES.map(pkg => `${pkg.path}/package.json`),
    'packages/browser/src/index.ts', 'packages/protocol/src/index.ts',
    'packages/protocol/README.md', 'packages/protocol/README.ko.md',
  ];
  for (const file of files) cpSync(file, join(scratch, file), { recursive: true });
  const current = assertVersions(scratch);
  const next = nextPatch(current);
  setVersion(next, scratch);
  assert.equal(assertVersions(scratch), next);
  const browser = JSON.parse(readFileSync(join(scratch, 'packages/browser/package.json')));
  assert.equal(browser.dependencies['browser-error-log-protocol'], next);
  assert.match(readFileSync(join(scratch, 'packages/protocol/README.md'), 'utf8'),
    new RegExp(`browser-error-log-protocol-${next.replaceAll('.', '\\.')}\\.tgz`));
  assert.throws(() => setVersion(next, scratch), /single patch bump/);
});

const integrity = 'sha512-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==';
const manifest = { version: '0.1.3', packages: Object.fromEntries(PACKAGES.map(pkg => [pkg.name, integrity])) };
const metadata = (name, version = '0.1.3', hash = integrity) => ({ name, version, dist: { integrity: hash } });
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('annotated release tag carries the immutable tarball manifest', () => {
  const repo = mkdtempSync(join(tmpdir(), 'browser-error-log-tag-'));
  const command = args => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  command(['init', '-q']);
  command(['config', 'user.name', 'release-test']);
  command(['config', 'user.email', 'release-test@example.invalid']);
  command(['commit', '--allow-empty', '-qm', 'source']);
  command(['tag', '-a', 'v0.1.3', '-m', JSON.stringify(manifest)]);
  const original = process.cwd();
  try {
    process.chdir(repo);
    assert.deepEqual(readTagManifest('v0.1.3'), manifest);
    command(['tag', 'v0.1.4']);
    assert.throws(() => readTagManifest('v0.1.4'), /annotated tag/);
  } finally {
    process.chdir(original);
  }
});

test('only an actual 404 means an exact npm version is absent', async () => {
  assert.equal(await lookupExactVersion('browser-error-log', '0.1.3', async () => response(404)), null);
  for (const status of [401, 403, 500]) {
    await assert.rejects(lookupExactVersion('browser-error-log', '0.1.3', async () => response(status)),
      new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(lookupExactVersion('browser-error-log', '0.1.3', async () => { throw Error('DNS'); }),
    /lookup failed/);
});

test('partial release resumes exact missing package; integrity mismatch fails before publishing', async () => {
  const partial = await releaseRegistryState(manifest, async url => {
    const name = decodeURIComponent(new URL(url).pathname.split('/')[1]);
    return name === 'browser-error-log' ? response(404) : response(200, metadata(name));
  });
  assert.deepEqual(partial, { missing: ['browser-error-log'], complete: false });
  await assert.rejects(releaseRegistryState(manifest, async url => {
    const name = decodeURIComponent(new URL(url).pathname.split('/')[1]);
    return response(200, metadata(name, '0.1.3', 'sha512-wrong'));
  }), /integrity mismatch/);
  assert.throws(() => assertTarballsMatchManifest({
    ...Object.fromEntries(PACKAGES.map(pkg => [pkg.name, { integrity }])),
    'browser-error-log': { integrity: 'sha512-wrong' },
  }, manifest), /immutable release tag/);
});

test('publisher follow-up advances only the current tag after every registry digest matches', async () => {
  const complete = async url => {
    const name = decodeURIComponent(new URL(url).pathname.split('/')[1]);
    return response(200, metadata(name));
  };
  const input = { tag: 'v0.1.3', manifest, successfulRun: false,
    eventName: 'workflow_dispatch', inputTag: 'v0.1.3', verifiedAttempt: true, fetchImpl: complete };
  assert.deepEqual(await releaseAdvanceState(input), { ready: true, missing: [] });
  assert.deepEqual(await releaseAdvanceState({ ...input, successfulRun: true, inputTag: null }),
    { ready: true, missing: [] });

  const noFetch = async () => { throw Error('registry should not be queried without release proof'); };
  for (const changed of [
    { inputTag: 'v0.1.2' },
    { inputTag: null },
    { eventName: 'push' },
    { verifiedAttempt: false },
    { tag: 'v0.1.4', manifest: { ...manifest, version: '0.1.4' } },
  ]) {
    assert.deepEqual(await releaseAdvanceState({ ...input, ...changed, fetchImpl: noFetch }),
      { ready: false, missing: null });
  }

  const partial = await releaseAdvanceState({ ...input, fetchImpl: async url => {
    const name = decodeURIComponent(new URL(url).pathname.split('/')[1]);
    return name === 'browser-error-log-react' ? response(404) : response(200, metadata(name));
  } });
  assert.deepEqual(partial, { ready: false, missing: ['browser-error-log-react'] });
  await assert.rejects(releaseAdvanceState({ ...input, fetchImpl: async url => {
    const name = decodeURIComponent(new URL(url).pathname.split('/')[1]);
    return response(200, metadata(name, '0.1.3', 'sha512-wrong'));
  } }), /integrity mismatch/);
});

test('publisher proof requires this tag, commit, workflow and successful job in the latest attempt', async () => {
  const run = {
    id: 42, run_attempt: 2, event: 'workflow_dispatch', path: '.github/workflows/publish.yml',
    repository: { full_name: 'hyeonse-swing/browser-error-log' },
    head_repository: { full_name: 'hyeonse-swing/browser-error-log' },
    head_branch: 'v0.1.3', head_sha: 'tag-commit',
  };
  const job = { name: 'publish', status: 'completed', conclusion: 'success',
    run_id: 42, run_attempt: 2, head_branch: 'v0.1.3', head_sha: 'tag-commit' };
  const proof = { tag: 'v0.1.3', headSha: 'tag-commit', runId: '42', attempt: '2' };
  const api = (candidateRun = run, candidateJob = job) => async path =>
    path.includes('/jobs?') ? { total_count: 1, jobs: [candidateJob] } : candidateRun;
  assert.equal(await verifiedPublishAttempt({ ...proof, api: api() }), true);
  assert.equal(isSuccessfulTaggedPublishRun({ ...run, status: 'completed', conclusion: 'success' },
    'v0.1.3', 'tag-commit'), true);
  assert.equal(isSuccessfulTaggedPublishRun({ ...run, status: 'completed', conclusion: 'success', head_branch: 'main' },
    'v0.1.3', 'tag-commit'), false);
  assert.equal(isSuccessfulTaggedPublishRun({ ...run, status: 'completed', conclusion: 'success', path: '.github/workflows/other.yml' },
    'v0.1.3', 'tag-commit'), false);
  for (const changed of [
    { head_sha: 'another-commit' }, { head_branch: 'v0.1.2' },
    { path: '.github/workflows/other.yml' }, { event: 'push' },
    { run_attempt: 1 }, { repository: { full_name: 'someone/else' } },
  ]) {
    assert.equal(await verifiedPublishAttempt({ ...proof, api: api({ ...run, ...changed }) }), false);
  }
  for (const changed of [
    { conclusion: 'failure' }, { status: 'in_progress' }, { run_attempt: 1 },
    { head_sha: 'another-commit' }, { name: 'catchup' },
  ]) {
    assert.equal(await verifiedPublishAttempt({ ...proof, api: api(run, { ...job, ...changed }) }), false);
  }
  assert.equal(await verifiedPublishAttempt({ ...proof, attempt: '1', api: api() }), false);
  assert.equal(await verifiedPublishAttempt({ ...proof, runId: 'invalid', api: async () => { throw Error('unexpected API call'); } }), false);
});

test('registry visibility retries 404, then verifies digest; server errors do not retry', async () => {
  let requests = 0;
  const fetched = await waitForRegistryPackage('browser-error-log', manifest, {
    fetchImpl: async () => (++requests < 3 ? response(404) : response(200, metadata('browser-error-log'))),
    sleepImpl: async () => {},
  });
  assert.equal(fetched.version, '0.1.3');
  assert.equal(requests, 3);
  requests = 0;
  await assert.rejects(waitForRegistryPackage('browser-error-log', manifest, {
    fetchImpl: async () => { requests++; return response(503); },
    sleepImpl: async () => {},
  }), /HTTP 503/);
  assert.equal(requests, 1);
});
