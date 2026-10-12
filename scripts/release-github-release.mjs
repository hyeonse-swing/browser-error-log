import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  PACKAGES, REPOSITORY, UNTAGGED_BASELINE, assertVersions, git, readTagManifest,
} from './release-common.mjs';

const releaseUrl = tag => `https://github.com/${REPOSITORY}/releases/tag/${tag}`;

export function buildGithubReleaseNotes({ tag, previousRef, commits }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^(?:v\d+\.\d+\.\d+|[a-f0-9]{40})$/.test(previousRef)) {
    throw new Error('Invalid release note references');
  }
  const version = tag.slice(1);
  const changes = commits.length ? commits.map(({ sha, subject }) => {
    if (!/^[a-f0-9]{40}$/.test(sha) || typeof subject !== 'string' || !subject.trim()) {
      throw new Error('Invalid source commit for release notes');
    }
    const label = subject.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
    return `- ${label} ([${sha.slice(0, 7)}](https://github.com/${REPOSITORY}/commit/${sha}))`;
  }).join('\n') : '- No source commits since the previous release.';
  const packages = PACKAGES.map(pkg =>
    `- [${pkg.name}@${version}](https://www.npmjs.com/package/${pkg.name}/v/${version})`).join('\n');
  return `## Changes since ${previousRef}\n\n${changes}\n\n## npm packages\n\n${packages}\n\n[Compare ${previousRef}...${tag}](https://github.com/${REPOSITORY}/compare/${previousRef}...${tag})\n`;
}

export function ensureGithubRelease({ tag, notes, lookup, create }) {
  const verify = release => {
    if (release?.tag_name !== tag || release.draft !== false || !release.published_at
      || release.body?.trim() !== notes.trim()) {
      throw new Error(`GitHub Release ${tag} differs from the published tag and expected notes`);
    }
  };
  const existing = lookup(tag);
  if (existing) {
    verify(existing);
    return 'already published';
  }
  try {
    create(tag, notes);
  } catch (error) {
    // Another attempt may have created the same release concurrently. An
    // unrelated API/permission failure remains fatal if no release appeared.
    const raced = lookup(tag);
    if (!raced) throw error;
    verify(raced);
    return 'already published';
  }
  verify(lookup(tag));
  return 'created';
}

function ghLookup(tag) {
  try {
    return JSON.parse(execFileSync('gh', ['api', `repos/${REPOSITORY}/releases/tags/${tag}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    if (/HTTP 404\b/.test(String(error.stderr ?? ''))) return null;
    throw error;
  }
}

function ghCreate(tag, notes) {
  execFileSync('gh', ['release', 'create', tag, '--repo', REPOSITORY,
    '--verify-tag', '--title', tag, '--notes-file', '-'], {
    input: notes, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function previousReleaseRef(tag) {
  const tags = git(['tag', '--merged', `${tag}^`, '--list', 'v*']).split('\n')
    .filter(value => /^v\d+\.\d+\.\d+$/.test(value));
  if (!tags.length) {
    if (tag !== 'v0.1.3') throw new Error(`No previous release tag found for ${tag}`);
    return UNTAGGED_BASELINE;
  }
  tags.sort((a, b) => {
    const left = a.slice(1).split('.').map(Number);
    const right = b.slice(1).split('.').map(Number);
    for (let index = 0; index < 3; index++) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return 0;
  });
  return tags[0];
}

function main() {
  const tag = process.env.GITHUB_REF_NAME;
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || !/^v\d+\.\d+\.\d+$/.test(tag ?? '')
    || process.env.GITHUB_REF !== `refs/tags/${tag}`) {
    throw new Error('GitHub Release requires an immutable version tag in this repository');
  }
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required to create the GitHub Release');
  const taggedCommit = git(['rev-parse', `refs/tags/${tag}^{commit}`]);
  if (git(['rev-parse', 'HEAD']) !== taggedCommit || tag !== `v${assertVersions()}`) {
    throw new Error('Checkout and package versions must match the release tag');
  }
  readTagManifest(tag);
  const remoteCommit = git(['ls-remote', 'origin', `refs/tags/${tag}^{}`]).split('\t')[0];
  if (remoteCommit !== taggedCommit) throw new Error(`Remote ${tag} does not match this immutable tagged commit`);
  const previousRef = previousReleaseRef(tag);
  git(['merge-base', '--is-ancestor', previousRef, `${tag}^`]);
  const commits = git(['log', '--no-merges', '--reverse', '--format=%H%x09%s',
    `${previousRef}..${tag}^`]).split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('\t');
    return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
  const notes = buildGithubReleaseNotes({ tag, previousRef, commits });
  const result = ensureGithubRelease({ tag, notes, lookup: ghLookup, create: ghCreate });
  console.log(`GitHub Release ${tag} ${result}: ${releaseUrl(tag)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
