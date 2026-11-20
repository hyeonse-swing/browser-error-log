# Browser Error Log

English | [한국어](README.ko.md)

[![npm version](https://img.shields.io/npm/v/@ihyeon%2Fbrowser-error-log.svg)](https://www.npmjs.com/package/@ihyeon/browser-error-log)

Capture browser failures on infrastructure you control. This project includes a framework-independent browser SDK, a React Error Boundary, a small self-hosted collector, and a viewer. A Node.js 24 process can persist events in SQLite and serve the viewer. You choose where records live, how long they remain, and who can read them. The public event types and transport hook also support a backend you own.

The MIT-licensed browser SDK, React adapter, and protocol are published separately under the `@ihyeon` scope: [@ihyeon/browser-error-log](https://www.npmjs.com/package/@ihyeon/browser-error-log), [@ihyeon/browser-error-log-react](https://www.npmjs.com/package/@ihyeon/browser-error-log-react), and [@ihyeon/browser-error-log-protocol](https://www.npmjs.com/package/@ihyeon/browser-error-log-protocol). The original unscoped packages remain available; see the [release guide](docs/releasing.md) for the migration, verified releases, and publishing workflow. The collector and viewer run on your own infrastructure. The English/Korean language selector belongs to the viewer, demo, and install example built from this repository; installing the SDK alone does not add that UI to an app.

## Start with persistent storage

Use Node.js 24.22.1 or a later 24.x patch and npm. With nvm, run `nvm install` and `nvm use` in the cloned repository before `npm ci` to select the version in [`.nvmrc`](.nvmrc).

```sh
git clone https://github.com/hyeonse-swing/browser-error-log.git
cd browser-error-log
npm ci
npm run micro
```

Open the [viewer](http://127.0.0.1:4319/) and [connection example](http://127.0.0.1:4319/install.html). Their language selector defaults to English and remembers your choice when browser storage is available. The collector accepts `POST http://127.0.0.1:4319/api/events` and stores records in `.data/micro-server/events.sqlite`. Send an example error, then refresh the viewer and select `my-web`. The default listener is local to your machine. After the first build, `npm run start:micro` restarts it using the same data directory.

SQLite defaults to seven days from server receipt, 10,000 events, and a 64 MiB limit for the main database file. Journal files and backups need additional space. [Self-hosting options](docs/micro-server.md) covers JSONL, external HTTPS access, and limits.

## Connect another app

In another web app, install the SDK:

```sh
npm install @ihyeon/browser-error-log
```

For an existing React 18/19 app, install the browser SDK and optional React adapter:

```sh
npm install @ihyeon/browser-error-log @ihyeon/browser-error-log-react
```

For a standard integration, install only `@ihyeon/browser-error-log`. It automatically installs `@ihyeon/browser-error-log-protocol`, the shared event types and constants used by SDKs and collectors. The protocol package does not capture errors or run a server. Add `@ihyeon/browser-error-log-react` only when you need a React Error Boundary. The [SDK guide](docs/personal-sdk.md) also covers local source-checkout tarballs.

For an app at `http://localhost:5173`, start the collector with that exact browser origin:

```sh
MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run start:micro
```

Initialize once in the app's browser entry point:

```ts
import { init } from '@ihyeon/browser-error-log';

export const errorLog = init({
  project: 'my-web',
  environment: 'development',
  release: 'local-example',
  endpoint: 'http://127.0.0.1:4319/api/events',
});

errorLog.captureException(new Error('Connection check'));
await errorLog.flush();
```

The viewer should show that event under `my-web`. `captureException()` returns an event ID when the SDK accepts it into the queue; confirm collector receipt separately. The default `standard` mode also observes global JavaScript exceptions, unhandled promises, fetch/XHR failures, and HTTP 5xx responses. Choose `preset: 'minimal'` for manual capture without automatic hooks or stacks, or `preset: 'detailed'` for additional console, resource, navigation, network breadcrumb, and cause details. Individual capture switches override the mode. React render errors can use [`ErrorBoundary`](docs/personal-sdk.md#react-and-ssr). See the [SDK guide](docs/personal-sdk.md#choose-a-capture-mode) for the full matrix, lifecycle, custom transport, and volume controls.

See the [repeatable CPU, memory, and payload benchmark (Korean)](docs/preset-performance-2026-11-17.ko.md) for 12 trials per condition, raw measurements, and reproduction steps. It separates equal-count manual logging from workloads where presets collect different events.

## Local source maps by release

Open the hosted viewer and choose **Import JSON** to inspect an archive. To try two releases, unzip the example, open `events.json`, then use **Local source maps** to register each release’s `manifest.json` and `assets/app.js.map`. Files are read in the current tab. [Hosted viewer](https://hyeonse-swing.github.io/browser-error-log/) · [Download the two-release example](https://hyeonse-swing.github.io/browser-error-log/source-map-example.zip)

Set a unique SDK `release` for each build. Keep the emitted JavaScript and its regular v3 `.map` file together. The viewer in this repository resolves their original locations. After `npm ci`, run this from the repository root for each deployed chunk:

```sh
npm run source-map:prepare -- --project my-web --environment production \
  --release build-42 --url https://cdn.example.com/assets/app.js \
  --bundle dist/assets/app.js --map dist/assets/app.js.map --out build-42.app.manifest.json
```

1. Open the viewer with `npm run dev`. In **Local source maps**, select the manifest and the matching `.map`, then choose **Register map**. The project, environment, release and full deployed asset URL must match the event. File selection and SHA-256 verification take place in this tab. Use HTTPS or localhost.
2. Open an error in the **Event Timeline** or **Error Dashboard**. **Original locations** shows the generated file, line and column alongside the original position. Both use one-based coordinates. Adjacent generated columns may map to the start of the same original token.
3. Register other releases the same way. Different artifacts registered under one key suspend mapping for that key. Remove it and register the intended build again. Reloading clears the registrations. Maps and original sources stay out of network requests and event exports.

Each map can be up to 8 MiB. A tab can hold up to 32 manual registrations totaling 32 MiB. For large builds, start with the chunks in the error stack.

**Try two releases.** Run the following from the repository root to create a fresh example directory. If you already generated it, start the viewer and reuse the files. Import `events.json` in the dashboard, then register `A/manifest.json` with `A/assets/app.js.map`. Repeat for B. The two synthetic events resolve to `release-a.ts:2:3` and `release-b.ts:7:3`.

```sh
node examples/source-maps/build-fixture.mjs --output-dir output/source-map-example
npm run dev
```

Events do not carry a hash of the executed JavaScript. Assign a fresh release ID when replacing a build at the same URL. Missing maps and ambiguous frames show an unmapped reason. SDK 0.2.20 preserves verified positions from scripts with query strings. JavaScript and React component frames with a usable bundle URL, line and column resolve independently. Name-only React frames retain their reported names. Imported frames with a raw query or fragment remain unmapped. The viewer never fetches linked sources or follows intermediate maps. [Source map coordinate conventions](https://tc39.es/ecma426/#sec-terms-and-definitions)

### Register from a build and inspect source code

In the self-hosted SQLite viewer, CI can register hidden maps for each release before deploying its JavaScript. The timeline and dashboard retrieve matching maps for live events. Open **View source** beside a mapped JavaScript or React frame to see the original line and highlighted column when the map embeds `sourcesContent`. Maps without embedded source still provide coordinates. JSON archives use tab-local registrations. [Collector configuration, GitHub Actions and CLI](docs/source-map-ci.md)

## AI-assisted integration

Use the [portable integration skill](skills/browser-error-log/SKILL.md) with an existing coding agent. All three npm packages include `ai/` with the skill, its self-contained references, the measured 0.2.13 performance report, raw results and reproduction scripts. See the [AI guide](docs/ai.md) for local copy instructions and version checks.

## Why use it

- **Own the data path:** run the collector with SQLite, keep rotating JSONL logs, or implement the v1 schema in your own backend. You set retention, access, backup, and deletion policies.
- **Inspect useful context:** filter by project, environment, type, and time; search messages, releases, and pages; inspect stacks and network status; export a bounded JSON snapshot for offline analysis. Charts count captured events, not users or a percentage of all requests.
- **Keep integration flexible:** use the supplied endpoint or `transport(batch, { signal })`. Public event and viewer data-source types support a self-owned backend.
- **Bound reporting work:** queue, batch, timeout, and retry limits make delivery best-effort and keep diagnostics from replacing an application error.

The SDK strips URL query strings, fragments, and user information and masks common sensitive patterns. This does **not** guarantee complete redaction: add application-specific `sanitizeUrl` and `beforeSend` rules. Request/response bodies, cookies, form values, DOM snapshots, and session replay are not collected. Alerts, native crashes, and guaranteed delivery are not included.

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.

## Other paths

`npm run dev` starts a memory-only local demo at `http://127.0.0.1:4317/`; sample records are synthetic and collected events disappear on restart. The viewer, demo, and install example have an English-default language selector that remembers your choice when browser storage is available. `npm run collector` starts a separate memory-only collector on port 4318. Use `npm run micro` for file-backed records. Read the [v1 integration contract](docs/integration.md), [backend contract](docs/server-request.md), and [roadmap](docs/expansion-roadmap.md) for more detail.

| Path | Purpose |
| --- | --- |
| `packages/browser` | Framework-independent browser SDK |
| `packages/react` | React Error Boundary adapter |
| `packages/protocol` | v1 event and query types |
| `apps/viewer` | Dashboard, timeline, detail, JSON import/export |
| `apps/demo`, `apps/local-collector` | Local development examples; memory only |
| `examples/micro-server` | File-backed SQLite or JSONL collector |

Run `npm run check`, `npm run check:package`, and `npm run check:micro` to validate code and built examples. For actual Chromium and WebKit delivery checks, install the test browsers once and run:

```sh
npx playwright install --with-deps chromium firefox webkit
npm run check:browser
```

The browser suite sends runtime errors, unhandled promise rejections, and failed HTTP requests through the built SDK to a temporary local collector. Pull requests to `main` run these checks in [Verify changes](https://github.com/hyeonse-swing/browser-error-log/actions/workflows/ci.yml). See the [release guide](docs/releasing.md) for automatic patch releases, manual minor/major releases, and GitHub release notes. External TLS, a specific deployment, and real device behavior require separate checks in that environment.
