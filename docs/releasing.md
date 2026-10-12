# npm release

English | [한국어](ko/releasing.md)

The [GitHub repository](https://github.com/hyeonse-swing/browser-error-log) holds the MIT-licensed source. All three SDK packages have a published `0.1.0` version. The browser SDK and protocol also have published `0.1.1` versions; `browser-error-log-react@0.1.1` was never published and its latest public version is `0.1.0`. A `0.1.2` maintenance release is being prepared but is not yet published. The workspace root and apps remain private. npm publication is separate from a GitHub release or tag.

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

## Pending `0.1.2` maintenance release

`0.1.2` is a candidate, not a published or registry-verified release. Its maintenance changes are:

- The browser SDK strips query strings from relative URL-like values in error text and context while retaining relative paths. This includes slash-containing and bare sibling paths, query-only references, and bracket or fragment cases. It is best-effort masking, not guaranteed anonymization.
- The React Error Boundary gives its fallback an `Error` even when a component throws `null`, `undefined`, `false`, `0`, an empty string, or another non-`Error` value, including one whose `toString` throws. It still forwards the original thrown value to `captureException`.
- JSONL startup rejects preexisting logs that exceed a lowered file-size or file-count cap without deleting previously acknowledged records. Recovery of a truncated final line remains supported.
- A dashboard test freezes its clock so its fixture does not depend on the current date; this does not change runtime behavior.

`npm run check` passed typecheck, 96 tests across 12 files, and the build; the browser SDK gzip size was 4,934 of the 20,480-byte budget. `npm run check:package` passed isolated `0.1.2` tarball installation and TypeScript, ESM, CommonJS, SSR, and browser-only checks without React. The built micro-server smoke check passed. Registry publication and verification are still pending.

Release validation commands:

```sh
npm ci
npm run check
npm run check:package
npm run check:micro
```

For the currently published browser SDK, use `npm install browser-error-log`; its protocol dependency resolves transitively. For React, use the matching published `0.1.0` pair: `npm install browser-error-log@0.1.0 browser-error-log-react@0.1.0`. The `0.1.2` workspace's `check:package` builds `browser-error-log-protocol-0.1.2.tgz`, `browser-error-log-0.1.2.tgz`, and `browser-error-log-react-0.1.2.tgz` under `output/packages/`; see the [SDK guide](personal-sdk.md). Local tarballs alone do not prove registry publication.

## Future releases

Npm versions are immutable. Do not attempt to republish `0.1.0` or any version after it is published; choose a new version for each subsequent release.

1. Confirm the MIT license still covers the included source and assets. Keep `company/`, local data, secrets, logs, and verification artifacts out of package tarballs.
2. Update and inspect package metadata, README content, dependency versions, and tarball files. Keep the workspace root and apps private.
3. Run the local checks above and use an authorized npm account with required login and 2FA. Keep credentials and tokens out of the repository, command arguments, and logs. Publish in dependency order: protocol, browser SDK, then React adapter.
4. Verify the new versions, `dist.integrity` metadata, and tarball contents from npm. Repeat the fresh-consumer TypeScript, ESM, CommonJS, and SSR checks against registry packages.
5. If making a GitHub release or tag, create and verify it separately from npm publication.

The root package's `private: true` is intentional. Do not publish or change it merely to ship the SDK packages. A successful local `npm pack`, GitHub tag, or workflow start does not prove an npm release.

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.
