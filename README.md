# Browser Error Log

Capture browser failures on infrastructure you control. This project includes a framework-independent browser SDK, a React Error Boundary, a small self-hosted collector, and a viewer. A Node.js 24 process can persist events in SQLite and serve the viewer. You choose where records live, how long they remain, and who can read them. The public event types and transport hook also support a backend you own.

**Release candidate:** MIT has been selected for the first `0.1.0` source and npm release. The three SDK packages are being prepared for publication; authenticated npm publication and registry installation have not yet been verified. Use the local tarballs below until that verification is complete. See [release readiness](docs/releasing.md). A GitHub source release and npm registry publication are separate actions.

## Start with persistent storage

With Node.js 24 and npm:

```sh
git clone https://github.com/hyeonse-swing/browser-error-log.git
cd browser-error-log
npm ci
npm run micro
```

Open the [viewer](http://127.0.0.1:4319/) and [connection example](http://127.0.0.1:4319/install.html). The collector accepts `POST http://127.0.0.1:4319/api/events` and stores records in `.data/micro-server/events.sqlite`. Send an example error, then refresh the viewer and select `my-web`. The default listener is local to your machine. After the first build, `npm run start:micro` restarts it using the same data directory.

SQLite defaults to seven days from server receipt, 10,000 events, and a 64 MiB limit for the main database file. Journal files and backups need additional space. [Self-hosting options](docs/micro-server.md) covers JSONL, external HTTPS access, and limits.

## Connect another app

Build and verify the local tarballs:

```sh
npm run check:package
```

After all three packages have been published and verified on npm, the registry commands will be `npm install browser-error-log` or `npm install browser-error-log browser-error-log-react` for React. `browser-error-log-protocol` will resolve as a dependency; consumers normally do not install it directly unless using its types or constants.

In the consuming app, set `SDK_DIR` to this checkout's absolute path and install the protocol and browser packages together:

```sh
SDK_DIR="/absolute/path/to/browser-error-log"
npm install "$SDK_DIR/output/packages/browser-error-log-protocol-0.1.0.tgz" \
  "$SDK_DIR/output/packages/browser-error-log-0.1.0.tgz"
```

For an existing React 18/19 app, add the adapter:

```sh
SDK_DIR="/absolute/path/to/browser-error-log"
npm install "$SDK_DIR/output/packages/browser-error-log-protocol-0.1.0.tgz" \
  "$SDK_DIR/output/packages/browser-error-log-0.1.0.tgz" \
  "$SDK_DIR/output/packages/browser-error-log-react-0.1.0.tgz"
```

For an app at `http://localhost:5173`, start the collector with that exact browser origin:

```sh
MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run start:micro
```

Initialize once in the app's browser entry point:

```ts
import { init } from 'browser-error-log';

export const errorLog = init({
  project: 'my-web',
  environment: 'development',
  release: 'local-example',
  endpoint: 'http://127.0.0.1:4319/api/events',
});

errorLog.captureException(new Error('Connection check'));
await errorLog.flush();
```

The viewer should show that event under `my-web`. The SDK also observes global JavaScript exceptions, unhandled promises, fetch/XHR failures, and HTTP 5xx responses by default. `console.error` capture is opt-in. React render errors can use [`ErrorBoundary`](docs/personal-sdk.md#react-and-ssr). See the [SDK guide](docs/personal-sdk.md) for lifecycle, custom transport, and data controls.

## Why use it

- **Own the data path:** run the collector with SQLite, keep rotating JSONL logs, or implement the v1 schema in your own backend. You set retention, access, backup, and deletion policies.
- **Inspect useful context:** filter by project, environment, type, and time; search messages, releases, and pages; inspect stacks and network status; export a bounded JSON snapshot for offline analysis. Charts count captured events, not users or a percentage of all requests.
- **Keep integration flexible:** use the supplied endpoint or `transport(batch, { signal })`. Public event and viewer data-source types support a self-owned backend.
- **Bound reporting work:** queue, batch, timeout, and retry limits make delivery best-effort and keep diagnostics from replacing an application error.

The SDK strips URL query strings, fragments, and user information and masks common sensitive patterns. This does **not** guarantee complete redaction: add application-specific `sanitizeUrl` and `beforeSend` rules. Request/response bodies, cookies, form values, DOM snapshots, and session replay are not collected. Source-map automation, alerts, native crashes, and guaranteed delivery are not included.

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.

## Other paths

`npm run dev` starts a memory-only local demo at `http://127.0.0.1:4317/`; sample records are synthetic and collected events disappear on restart. `npm run collector` starts a separate memory-only collector on port 4318. Use `npm run micro` for file-backed records. Read the [v1 integration contract](docs/integration.md), [backend contract](docs/server-request.md), and [roadmap](docs/expansion-roadmap.md) for more detail.

| Path | Purpose |
| --- | --- |
| `packages/browser` | Framework-independent browser SDK |
| `packages/react` | React Error Boundary adapter |
| `packages/protocol` | v1 event and query types |
| `apps/viewer` | Dashboard, timeline, detail, JSON import/export |
| `apps/demo`, `apps/local-collector` | Local development examples; memory only |
| `examples/micro-server` | File-backed SQLite or JSONL collector |

Run `npm run check`, `npm run check:package`, and `npm run check:micro` to validate code and built examples. External TLS, a specific deployment, and real device behavior require separate checks in that environment.
