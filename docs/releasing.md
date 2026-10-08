# Release readiness

The [GitHub repository](https://github.com/hyeonse-swing/browser-error-log) contains the personal project's source preview. It is **not yet an open-source or npm release**: license selection is pending, all three package manifests retain `private: true`, and npm package scope/name ownership is unresolved. No npm publication has been executed.

## Recommended license

MIT is the proposed license for this small, reusable SDK. It permits use, modification, and redistribution, including commercial use, with the copyright and permission notice retained. This keeps adoption straightforward for personal and commercial apps. See the [official MIT text](https://opensource.org/license/mit). This is a recommendation, not an applied license: no `LICENSE` file or package license declaration has been added yet.

## Current local path

Use Node.js 24 and npm from a source checkout:

```sh
npm ci
npm run check:package
```

The check writes `output/packages/browser-error-log-protocol-0.1.0.tgz`, `browser-error-log-browser-0.1.0.tgz`, and `browser-error-log-react-0.1.0.tgz`; it installs and smoke-checks them offline in temporary consumer projects. See the [SDK guide](personal-sdk.md) for complete install commands with an absolute `SDK_DIR` placeholder. This validation is local and does not prove publication or broad consumer compatibility.

## Before a public release

1. Select a license and add its license text after confirming all included code and assets can be released under it.
2. Keep the public source tree separate from `company/`, local data, environment files, logs, and verification artifacts. Confirm ownership and availability of the npm package scope and names. The npm package allowlists include built package files and package documentation, not the entire workspace.
3. Review package manifests and public package documentation, then deliberately remove `private: true` only for packages selected for publishing.
4. Validate package contents and a fresh consumer install, run `npm run check`, `npm run check:package`, and `npm run check:micro`, and inspect any published artifact before release.
5. Define versioning, provenance, and publication credentials; publish only with explicit authorization. Replace local-tarball instructions with verified npm commands only after the packages are actually available.

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.
