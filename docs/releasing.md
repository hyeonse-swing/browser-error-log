# First release: `0.1.0`

The [GitHub repository](https://github.com/hyeonse-swing/browser-error-log) holds the source. MIT is applied for the first public release. The chosen npm names are `browser-error-log-protocol`, `browser-error-log`, and `browser-error-log-react`; registry lookups returned 404 before the release attempt, but the final ownership and availability check belongs at publish time. The workspace root and apps remain private; the three SDK packages are prepared for npm. Authenticated npm publication and a GitHub source release are separate actions. At this release-candidate stage, neither is verified complete.

## Local package validation

With Node.js 24 and npm, from a source checkout:

```sh
npm ci
npm run check
npm run check:package
npm run check:micro
```

`check:package` builds three `0.1.0` tarballs in `output/packages/` and installs them offline in isolated consumers. The files are `browser-error-log-protocol-0.1.0.tgz`, `browser-error-log-0.1.0.tgz`, and `browser-error-log-react-0.1.0.tgz`. See the [SDK guide](personal-sdk.md) for complete local install commands using an absolute `SDK_DIR` placeholder. Inspect each tarball's metadata and files as part of the release check; a local smoke check is not registry proof.

## Publication checklist

1. Confirm the applied MIT license covers the source, package metadata, and included assets. Keep `company/`, local data, secrets, logs, and verification artifacts out of the public package tarballs.
2. Confirm the three unscoped names are still available and controlled by the intended npm account. Keep the workspace root and apps private. Verify repository URLs, package descriptions, README content, and files in each tarball.
3. Use an authorized npm account with required login and 2FA. Keep credentials and tokens out of the repository, command arguments, and logs. Publish in dependency order: `browser-error-log-protocol`, then `browser-error-log`, then `browser-error-log-react`, all at `0.1.0`.
4. Verify the exact versions and tarball contents from the npm registry. In a fresh consumer, install `browser-error-log`; for React, install `browser-error-log browser-error-log-react`. Check TypeScript, ESM, CommonJS, and SSR imports again against registry packages.
5. Create and verify the GitHub source release separately if desired. Only after registry checks pass, update the root README's release-candidate notice and the local-first installation guide with the confirmed npm path.

The root package's `private: true` is intentional. Do not publish or change it merely to ship the three SDK packages. No package is considered published based on a successful local `npm pack`, a GitHub tag, or a workflow start.

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.
