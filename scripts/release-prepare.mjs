import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REPOSITORY, UNTAGGED_BASELINE, assertVersions, createTagManifest, decideRelease,
  git, isStalePush, nextPatch, packRelease, readTagManifest, run, setVersion,
} from './release-common.mjs';
import { releaseAdvanceState } from './release-registry.mjs';
import { isSuccessfulTaggedPublishRun, verifiedPublishAttempt } from './release-github.mjs';

if (process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Release preparation is allowed only on this repository main branch');
}
if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required to inspect and dispatch release workflows');

const gh = args => JSON.parse(execFileSync('gh', ['api', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}));
const dispatch = (workflow, ref) => run('gh', [
  'api', '--method', 'POST', `repos/${REPOSITORY}/actions/workflows/${workflow}/dispatches`,
  '-f', `ref=${ref}`,
]);
const inputs = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).inputs ?? {} : {};

git(['fetch', '--tags', 'origin', 'main']);
const remoteMain = git(['rev-parse', 'refs/remotes/origin/main']);
const localHead = git(['rev-parse', 'HEAD']);
if (isStalePush(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_SHA, remoteMain, localHead)) {
  console.log('Stale main event or checkout; a newer main event will inspect all changes.');
  process.exit(0);
}
if (git(['status', '--porcelain'])) throw new Error('Release preparation requires a clean checkout');

const version = assertVersions();
const tag = `v${version}`;
const hasTag = git(['tag', '--list', tag]).split('\n').includes(tag);
let base;
let published = true;
if (hasTag) {
  base = git(['rev-parse', `refs/tags/${tag}^{commit}`]);
  git(['merge-base', '--is-ancestor', base, 'HEAD']);
  const manifest = readTagManifest(tag);
  const response = gh([`repos/${REPOSITORY}/actions/workflows/publish.yml/runs?event=workflow_dispatch&per_page=100`]);
  const runs = response.workflow_runs.filter(run => run.head_sha === base);
  const verifiedAttempt = inputs.verified_release_tag === tag && await verifiedPublishAttempt({
    tag, headSha: base, runId: inputs.publish_run_id, attempt: inputs.publish_run_attempt,
    api: path => gh([path]),
  });
  const advance = await releaseAdvanceState({ tag, manifest,
    successfulRun: runs.some(run => isSuccessfulTaggedPublishRun(run, tag, base)),
    eventName: process.env.GITHUB_EVENT_NAME, inputTag: inputs.verified_release_tag, verifiedAttempt });
  published = advance.ready;
  if (advance.missing?.length) console.log(`Release ${tag} is incomplete on npm: ${advance.missing.join(', ')}`);
  if (!published) {
    if (!runs.some(run => run.status !== 'completed')) {
      dispatch('publish.yml', tag);
      console.log(`Re-dispatched unfinished release ${tag}; source changes remain queued on main.`);
    } else {
      console.log(`Release ${tag} is still running; source changes remain queued on main.`);
    }
    process.exit(0);
  }
} else {
  if (version !== '0.1.2' || git(['tag', '--list', 'v*'])) {
    throw new Error(`No release tag for ${version}; refusing to reuse or skip a version`);
  }
  git(['merge-base', '--is-ancestor', UNTAGGED_BASELINE, 'HEAD']);
  base = UNTAGGED_BASELINE;
}

const paths = git(['diff', '--name-only', `${base}..HEAD`]).split('\n').filter(Boolean);
const decision = decideRelease({ tagExists: hasTag, published, paths });
if (decision === 'skip') {
  console.log(`No SDK release changes since ${hasTag ? tag : 'verified 0.1.2 baseline'}; skip.`);
  process.exit(0);
}

const next = nextPatch(version);
const nextTag = `v${next}`;
if (git(['tag', '--list', nextTag])) throw new Error(`${nextTag} already exists; refusing to reuse a release tag`);
console.log(`Preparing ${nextTag} from ${localHead}.`);
setVersion(next);
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
run('node', ['--test', 'scripts/release.test.mjs']);
run('npm', ['run', 'check']);
run('npm', ['run', 'check:package']);
run('npm', ['run', 'check:micro']);
const tarballs = packRelease(resolve('output/release'));
const manifest = createTagManifest(next, tarballs);

// Recheck after slow validations. A concurrent main update must be handled by
// its own event, never overwritten by the release bot.
git(['fetch', 'origin', 'main']);
if (git(['rev-parse', 'refs/remotes/origin/main']) !== localHead) {
  throw new Error('main advanced during release checks; refusing to push a stale version bump');
}
git(['config', 'user.name', 'github-actions[bot]']);
git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
git(['add', 'package.json', 'package-lock.json', 'apps/viewer/package.json',
  ...['protocol', 'browser', 'react'].map(name => `packages/${name}/package.json`),
  'packages/browser/src/index.ts', 'packages/protocol/src/index.ts',
  'packages/protocol/README.md', 'packages/protocol/README.ko.md']);
git(['commit', '-m', `chore: release ${nextTag}`]);
git(['tag', '-a', nextTag, '-m', JSON.stringify(manifest)]);
git(['push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${nextTag}`]);
dispatch('publish.yml', nextTag);
console.log(`Pushed ${nextTag} and dispatched the immutable-tag publisher.`);
