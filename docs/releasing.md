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

## Automatic releases from main

Push SDK changes to `main` to start [Prepare npm release](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/prepare.yml). The workflow checks for package or build changes since the previous release, increases the shared patch version, and runs the release checks. Changes limited to the root README, guides, or viewer do not publish an SDK release.

Preparation commits the synchronized package versions, dependency pins, lockfile, and SDK version values, then pushes a `vX.Y.Z` tag pointing to that commit. It starts [Publish npm release](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/publish.yml) on the tag. The publisher rebuilds and checks that exact source, publishes protocol → browser SDK → React adapter, and verifies the registry artifacts and fresh installations. A tag reserves the release version; the publishing workflow must finish successfully before the release is complete.

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) with GitHub OIDC. Each package is connected to `hyeonse-swing/browser-error-log`, workflow `publish.yml`, environment `npm`, with direct publishing allowed. The GitHub environment permits only `v*` tags, and a repository ruleset blocks updates and deletion of those tags. No npm token secret is needed. Maintainers may need npm 2FA when changing the trusted publisher connection.

If publication stops partway, rerun the failed publishing workflow using the original tag. It checks the integrity of already published packages and publishes only missing packages. Do not move the tag or change the source for that version. Preparation will not increment past an unfinished release. After registry and fresh-install verification succeeds, the publisher explicitly dispatches another preparation check to pick up SDK changes that arrived meanwhile. That check verifies the tagged publish job succeeded and every package matches the tag manifest before advancing. The same checks can also be started manually:

```sh
# Replace vX.Y.Z with the existing failed release tag.
gh workflow run publish.yml --repo hyeonse-swing/browser-error-log --ref vX.Y.Z
gh workflow run prepare.yml --repo hyeonse-swing/browser-error-log --ref main
```

The repository's About website and README badge link to npm. GitHub's Packages sidebar lists GitHub Packages, a separate registry; these packages are published to npmjs.org.

## Manual release checklist

Npm versions are immutable. Do not attempt to republish `0.1.0` or any version after it is published; choose a new version for each subsequent release.

1. Confirm the MIT license still covers the included source and assets. Keep `company/`, local data, secrets, logs, and verification artifacts out of package tarballs.
2. Update and inspect package metadata, README content, dependency versions, and tarball files. Keep the workspace root and apps private.
3. Run the local checks above and use an authorized npm account with required login and 2FA. Keep credentials and tokens out of the repository, command arguments, and logs. Publish in dependency order: protocol, browser SDK, then React adapter.
4. Verify the new versions, `dist.integrity` metadata, and tarball contents from npm. Repeat the fresh-consumer TypeScript, ESM, CommonJS, and SSR checks against registry packages.
5. If making a GitHub release or tag, create and verify it separately from npm publication.

The root package's `private: true` is intentional. Do not publish or change it merely to ship the SDK packages. A successful local `npm pack`, GitHub tag, or workflow start does not prove an npm release.

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.
