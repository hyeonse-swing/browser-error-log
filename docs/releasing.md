# npm release

English | [한국어](ko/releasing.md)

The [GitHub repository](https://github.com/hyeonse-swing/browser-error-log) holds the MIT-licensed source. The browser SDK, protocol, and React adapter are published on npm; the release history below records verified versions. All three have a published `0.1.0` version; the browser SDK and protocol have published `0.1.1` versions, while `browser-error-log-react@0.1.1` was never published. Before `0.1.2`, the React adapter's latest public version was `0.1.0`. The workspace root and apps remain private. npm publication is separate from a GitHub release or tag.

## Verified `0.1.0` packages

Published on October 8, 2026:

| Package | Purpose |
| --- | --- |
| [browser-error-log](https://www.npmjs.com/package/browser-error-log/v/0.1.0) | Browser SDK |
| [browser-error-log-react](https://www.npmjs.com/package/browser-error-log-react/v/0.1.0) | Optional React Error Boundary |
| [browser-error-log-protocol](https://www.npmjs.com/package/browser-error-log-protocol/v/0.1.0) | Event and query contracts |

All three `0.1.0` registry artifacts match the reviewed tarballs' SHA-512 integrity values. Fresh installations passed TypeScript, ESM, CommonJS, and SSR smoke checks, including a browser-only install without React. The `0.1.0` local release checks passed 74 tests, package checks, and the built micro server checks.

## Published `0.1.1` packages

| Package | Purpose |
| --- | --- |
| [browser-error-log](https://www.npmjs.com/package/browser-error-log/v/0.1.1) | Browser SDK |
| [browser-error-log-protocol](https://www.npmjs.com/package/browser-error-log-protocol/v/0.1.1) | Event and query contracts |

The two linked `0.1.1` versions are visible in the npm registry. Do not infer that the React adapter's local `0.1.1` tarball was published. Local i18n checks passed 81 tests, the SDK build, package checks, and micro-server checks; those local results are distinct from registry verification.

The repository's viewer, demo, and install example have an English-default language selector that remembers the selected language when browser storage is available. English and Korean documentation are linked in both directions. This UI is built from the source repository and is **not** part of the browser SDK runtime.

## Published `0.1.2` maintenance release

All three `0.1.2` packages are published and verified in the npm registry:

| Package | Purpose |
| --- | --- |
| [browser-error-log](https://www.npmjs.com/package/browser-error-log/v/0.1.2) | Browser SDK |
| [browser-error-log-react](https://www.npmjs.com/package/browser-error-log-react/v/0.1.2) | Optional React Error Boundary |
| [browser-error-log-protocol](https://www.npmjs.com/package/browser-error-log-protocol/v/0.1.2) | Event and query contracts |

The registry artifacts match the reviewed tarballs' SHA-512 integrity values. Fresh registry installations passed TypeScript, ESM, CommonJS, and SSR smoke checks, including a browser-only installation without React. The maintenance changes are:

- The browser SDK strips query strings from relative URL-like values in error text and context while retaining relative paths. This includes slash-containing and bare sibling paths, query-only references, and bracket or fragment cases. It is best-effort masking, not guaranteed anonymization.
- The React Error Boundary gives its fallback an `Error` even when a component throws `null`, `undefined`, `false`, `0`, an empty string, or another non-`Error` value, including one whose `toString` throws. It still forwards the original thrown value to `captureException`.
- JSONL startup rejects preexisting logs that exceed a lowered file-size or file-count cap without deleting previously acknowledged records. Recovery of a truncated final line remains supported.
- A dashboard test freezes its clock so its fixture does not depend on the current date; this does not change runtime behavior.

`npm run check` passed typecheck, 96 tests across 12 files, and the build; the browser SDK gzip size was 4,934 of the 20,480-byte budget. `npm run check:package` passed isolated `0.1.2` tarball installation and TypeScript, ESM, CommonJS, SSR, and browser-only checks without React. The built micro-server smoke check passed.

Release validation commands:

```sh
npm ci
npm run check
npm run check:package
npm run check:micro
```

Install the latest browser SDK with `npm install browser-error-log`; its protocol dependency resolves transitively. For React, use `npm install browser-error-log browser-error-log-react`. The `0.1.2` workspace's `check:package` builds `browser-error-log-protocol-0.1.2.tgz`, `browser-error-log-0.1.2.tgz`, and `browser-error-log-react-0.1.2.tgz` under `output/packages/`; see the [SDK guide](personal-sdk.md). Local tarballs alone do not prove registry publication.

## Verified `0.1.3` automated release

The first automatic release completed on October 12, 2026. A `main` push generated the `0.1.3` version commit and tag, then [GitHub Actions published all three packages](https://github.com/hyeonse-swing/browser-error-log/actions/runs/38190950148) using npm Trusted Publishing. All three downloaded tarballs match the SHA-512 values recorded in `v0.1.3`, and npm includes their provenance attestations.

The workflow passed 7 release tests, 96 application tests, typecheck, builds, package and micro-server checks, and fresh registry installation checks for TypeScript, ESM, CommonJS, SSR, and a browser-only installation without React.

## Verified `0.1.4` automated release

The [follow-up release](https://github.com/hyeonse-swing/browser-error-log/actions/runs/38191998049) published all three `0.1.4` packages on October 12, 2026. It passed 9 release tests, 96 application tests, typecheck, builds, package and micro-server checks, and fresh registry consumer checks. Registry verification confirmed all three as npm `latest`, with provenance attestations and downloaded tarballs matching the SHA-512 values in `v0.1.4`.

This release explicitly dispatches preparation after successful publication and verifies the originating publish job through the GitHub API before allowing another release. The [automatic follow-up check](https://github.com/hyeonse-swing/browser-error-log/actions/runs/38192593921) succeeded and skipped a version bump because no further SDK changes were present.

## Automatic releases from main

Push SDK changes to `main` to start [Prepare npm release](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/prepare.yml). The workflow checks for package or build changes since the previous release, increases the shared patch version, and runs the release checks. Changes limited to the root README, guides, or viewer do not publish an SDK release.

Preparation commits the synchronized package versions, dependency pins, lockfile, and SDK version values, then pushes a `vX.Y.Z` tag pointing to that commit. It starts [Publish npm release](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/publish.yml) on the tag. The publisher rebuilds and checks that exact source, publishes protocol → browser SDK → React adapter, and verifies the registry artifacts and fresh installations. After verification, a separate job creates a [GitHub Release](https://github.com/hyeonse-swing/browser-error-log/releases) for that existing tag with commit-based changes, a comparison link, and all three npm package links. Rerunning the same release reuses its existing GitHub Release. A tag reserves the release version; the publishing workflow must finish successfully before the release is complete.

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) with GitHub OIDC. Each package is connected to `hyeonse-swing/browser-error-log`, workflow `publish.yml`, environment `npm`, with direct publishing allowed. The GitHub environment permits only `v*` tags, and a repository ruleset blocks updates and deletion of those tags. No npm token secret is needed. Maintainers may need npm 2FA when changing the trusted publisher connection.

If publication stops partway, rerun the failed publishing workflow using the original tag. It checks the integrity of already published packages and publishes only missing packages. Do not move the tag or change the source for that version. Preparation will not increment past an unfinished release. After npm verification and GitHub Release creation succeed, the publisher explicitly dispatches another preparation check to pick up SDK changes that arrived meanwhile. That check verifies the tagged publish and GitHub Release jobs succeeded and every package matches the tag manifest before advancing. The same checks can also be started manually:

```sh
# Replace vX.Y.Z with the existing failed release tag.
gh workflow run publish.yml --repo hyeonse-swing/browser-error-log --ref vX.Y.Z
gh workflow run prepare.yml --repo hyeonse-swing/browser-error-log --ref main
```

The repository's About website and README badge link to npm. GitHub Releases provide version history in the repository. GitHub's Packages sidebar lists GitHub Packages, a separate registry; these packages are published to npmjs.org.

## Manual minor and major releases

The default remains automatic patch releases. To intentionally choose a minor or major release, dispatch preparation on `main` with `release_bump`:

```sh
gh workflow run prepare.yml --repo hyeonse-swing/browser-error-log --ref main -f release_bump=minor
# Or, for a major release:
gh workflow run prepare.yml --repo hyeonse-swing/browser-error-log --ref main -f release_bump=major
```

A minor release increments the minor version and resets patch to zero; a major release increments major and resets minor and patch to zero. These explicit manual requests also release when there are no new SDK file changes. They still require the previous release to be complete and run the same validation, version synchronization, and immutable-tag publication. If a previous release is unfinished, preparation resumes it when needed and reports that the manual bump must be requested again after completion. Pushes and automatic follow-up runs use patch. Changing a public API requires a deliberate compatibility decision; the workflow does not infer compatibility from a diff.

Each manual minor/major request starts a new preparation run with the commands above. Re-running a previous preparation attempt is rejected to prevent the same request from reserving another version. If the original run already created a tag, resume its publisher with that tag before requesting a new version.

## Pull-request and browser checks

[Verify changes](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/ci.yml) runs on pull requests to `main` and can also be dispatched manually. It checks release logic, TypeScript, application tests, builds, packaged consumers, the micro server, and real Chromium/WebKit delivery. The job has read-only repository permissions and does not publish packages. Failed browser runs retain their evidence as workflow artifacts for seven days.

Run the browser checks locally with `npx playwright install --with-deps chromium webkit`, then `npm run check:browser`. The suite builds the SDK and collector, uses temporary local data, and verifies runtime errors, unhandled promise rejections, and HTTP failures arrive at the collector. These browser-engine checks do not establish real-device or WebView compatibility.

## Manual release checklist

Npm versions are immutable. Do not attempt to republish `0.1.0` or any version after it is published; choose a new version for each subsequent release.

1. Confirm the MIT license still covers the included source and assets. Keep `company/`, local data, secrets, logs, and verification artifacts out of package tarballs.
2. Update and inspect package metadata, README content, dependency versions, and tarball files. Keep the workspace root and apps private.
3. Run the local checks above and use an authorized npm account with required login and 2FA. Keep credentials and tokens out of the repository, command arguments, and logs. Publish in dependency order: protocol, browser SDK, then React adapter.
4. Verify the new versions, `dist.integrity` metadata, and tarball contents from npm. Repeat the fresh-consumer TypeScript, ESM, CommonJS, and SSR checks against registry packages.
5. If making a GitHub release or tag, create and verify it separately from npm publication.

The root package's `private: true` is intentional. Do not publish or change it merely to ship the SDK packages. A successful local `npm pack`, GitHub tag, or workflow start does not prove an npm release.

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.
