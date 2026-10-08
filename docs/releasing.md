# npm release

English | [한국어](ko/releasing.md)

The [GitHub repository](https://github.com/hyeonse-swing/browser-error-log) holds the MIT-licensed source. Version `0.1.0` of `browser-error-log-protocol`, `browser-error-log`, and `browser-error-log-react` is published on npm. The workspace root and apps remain private; only the three SDK packages are published. A GitHub release or tag has not been created as part of this npm publication.

## Verified `0.1.0` packages

Published on October 8, 2026:

| Package | Purpose |
| --- | --- |
| [browser-error-log](https://www.npmjs.com/package/browser-error-log/v/0.1.0) | Browser SDK |
| [browser-error-log-react](https://www.npmjs.com/package/browser-error-log-react/v/0.1.0) | Optional React Error Boundary |
| [browser-error-log-protocol](https://www.npmjs.com/package/browser-error-log-protocol/v/0.1.0) | Event and query contracts |

All three `0.1.0` registry artifacts match the reviewed tarballs' SHA-512 integrity values. Fresh installations passed TypeScript, ESM, CommonJS, and SSR smoke checks, including a browser-only install without React. The `0.1.0` local release checks passed 74 tests, package checks, and the built micro server checks.

## `0.1.1` i18n release candidate

The pending `0.1.1` update adds an English-default language selector to the viewer, demo, and install example. It remembers the selected language when browser storage is available. English and Korean documentation are linked in both directions. The SDK runtime API and v1 event schema are unchanged; `sdkVersion` identifies the new package release. Local i18n checks passed 81 tests. This is a local result, **not** evidence that `0.1.1` is available on npm.

Use these commands to reproduce local validation before publication:

```sh
npm ci
npm run check
npm run check:package
npm run check:micro
```

The currently published install paths are `npm install browser-error-log` and, for React, `npm install browser-error-log browser-error-log-react`; until the new release is verified, npm may resolve `0.1.0`. The protocol package resolves transitively unless a consumer imports it directly. In this `0.1.1` source checkout, `check:package` builds `browser-error-log-protocol-0.1.1.tgz`, `browser-error-log-0.1.1.tgz`, and `browser-error-log-react-0.1.1.tgz` under `output/packages/`; see the [SDK guide](personal-sdk.md). Do not use local tarballs as proof of registry publication.

## Future releases

Npm versions are immutable. Do not attempt to republish `0.1.0` or any version after it is published; choose a new version for each subsequent release.

1. Confirm the MIT license still covers the included source and assets. Keep `company/`, local data, secrets, logs, and verification artifacts out of package tarballs.
2. Update and inspect package metadata, README content, dependency versions, and tarball files. Keep the workspace root and apps private.
3. Run the local checks above and use an authorized npm account with required login and 2FA. Keep credentials and tokens out of the repository, command arguments, and logs. Publish in dependency order: protocol, browser SDK, then React adapter.
4. Verify the new versions, `dist.integrity` metadata, and tarball contents from npm. Repeat the fresh-consumer TypeScript, ESM, CommonJS, and SSR checks against registry packages.
5. If making a GitHub release or tag, create and verify it separately from npm publication.

The root package's `private: true` is intentional. Do not publish or change it merely to ship the SDK packages. A successful local `npm pack`, GitHub tag, or workflow start does not prove an npm release.

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.
