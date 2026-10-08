# Install and connect the browser SDK

English | [한국어](ko/personal-sdk.md)

The SDK accepts an `endpoint` or a custom `transport`. React is optional. For persistent storage, start with the [self-hosting guide](micro-server.md).

The verified MIT-licensed `0.1.0` SDK packages are available on npm. The `0.1.1` i18n update is prepared locally and is not yet published. In the consuming app, install the browser SDK:

```sh
npm install browser-error-log
```

For an existing React 18/19 app, also install the adapter:

```sh
npm install browser-error-log browser-error-log-react
```

For ordinary app integration, you do not need a separate protocol install. `browser-error-log-protocol` is installed automatically with the SDK and contains the shared event types and constants. Install it directly only when importing those contracts in your own collector or viewer. It is not an error collector or a server.

## Optional: build local tarballs from source

Use Node.js 24 and npm from the repository root:

```sh
npm ci
npm run check:package
```

The script builds three `0.1.1` tarballs in `output/packages/` and installs them into isolated consumers to check browser-only installation, TypeScript declarations, ESM/CJS exports, and SSR imports. This path is for local development and does not publish anything.

In the consuming app, replace `SDK_DIR` with this checkout's absolute path:

```sh
SDK_DIR="/absolute/path/to/browser-error-log"
npm install "$SDK_DIR/output/packages/browser-error-log-protocol-0.1.1.tgz" \
  "$SDK_DIR/output/packages/browser-error-log-0.1.1.tgz"
```

For an existing React 18/19 app, add the adapter in the same install:

```sh
SDK_DIR="/absolute/path/to/browser-error-log"
npm install "$SDK_DIR/output/packages/browser-error-log-protocol-0.1.1.tgz" \
  "$SDK_DIR/output/packages/browser-error-log-0.1.1.tgz" \
  "$SDK_DIR/output/packages/browser-error-log-react-0.1.1.tgz"
```

The browser package does not require React. These packages export ESM, CommonJS, and TypeScript declarations for app bundlers; they do not provide a CDN global script.

## Connect to the included collector

For an app at `http://localhost:5173`, start the SQLite collector in this repository:

```sh
MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run micro
```

The exact origin must match, including hostname and port; `localhost` and `127.0.0.1` are different origins. Initialize once in the consuming app's browser entry point:

```ts
import { init } from 'browser-error-log';

export const errorLog = init({
  project: 'my-web',
  environment: 'development',
  release: 'local-example',
  endpoint: 'http://127.0.0.1:4319/api/events',
  captureConsole: false,
});

errorLog.captureException(new Error('SDK installation check'));
await errorLog.flush();
console.log(errorLog.getStats());
```

Refresh `http://127.0.0.1:4319/` and select `my-web`. A successful `sent` counter means a transport success response, not a backup or end-to-end delivery guarantee. Keep `init()` outside render paths. At test or hot-module teardown, call `await errorLog.flush()` if needed, then `errorLog.destroy()` to remove instrumentation and timers.

## Configuration reference

| Option | Default | Purpose |
| --- | --- | --- |
| `project` | Required | Group events under a project; match the collector's allowlist |
| `endpoint` | None | Collector URL; required unless using `transport` |
| `transport` | Built-in fetch transport | Send `EventBatch` with an abort `signal`; reject on failure |
| `environment` / `release` | `development` / `unknown` | Label the deployment and build |
| `runtime` | `browser` | `browser`, `webview-ios`, `webview-android`, or `unknown`; a label, not native instrumentation |
| `enabled` | `true` | Disable collection with `false` |
| `captureNetwork` | `true` | Observe fetch/XHR; a custom transport also needs `endpoint` |
| `captureConsole` | `false` | Opt in to `console.error` capture |
| `shouldCaptureHttp` | 5xx responses | Select HTTP statuses to capture |
| `sanitizeUrl` | Built-in URL cleanup | Remove application-specific path identifiers before the built-in cleanup |
| `beforeSend` | No custom filter | Edit an event or return `false`/`null` to drop it |
| `flushIntervalMs` | `10000` | Flush interval in ms; clamped to 10–60,000 |
| `maxQueueSize` | `50` | Buffered events; clamped to 1–100 |
| `transportTimeoutMs` | `5000` | Per-attempt deadline in ms; clamped to 250–60,000 |

The client exposes `captureException(error, extra?)`, `flush()`, `getStats()`, and `destroy()`. `extra` can include `context`, `componentStack`, and an event `type`. `getStats()` returns `queued`, `sent`, and `dropped` counts. A resolved `flush()` means delivery attempts have finished, including failures; it does not itself confirm success. `destroy()` cancels SDK work and discards pending events. Do not call it immediately after normal initialization.

## React and SSR

Reuse the same client with the React adapter:

```tsx
import { ErrorBoundary } from 'browser-error-log-react';
import { errorLog } from './error-log';

<ErrorBoundary client={errorLog} fallback={(_error, reset) => (
  <section><p>This view could not load.</p><button onClick={reset}>Try again</button></section>
)}>
  <App />
</ErrorBoundary>
```

Importing the SDK during SSR is supported; `init()` does not capture on the server. In Next.js or a similar framework, create the active client in a client-side entry point. Call `captureException` for errors handled by application `catch` blocks. This browser SDK cannot report native mobile crashes or a terminated WebView process.

## Own backend and data controls

Point `endpoint` to your v1 collector, or supply a custom transport:

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/monitoring/events',
  transport: async (batch, { signal }) => {
    const response = await fetch('/monitoring/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch), signal, credentials: 'omit',
    });
    if (!response.ok) throw new Error(`Collector responded ${response.status}`);
  },
});
```

The default transport uses `POST application/json` and `credentials: 'omit'`. With custom transport, include `endpoint` if you want automatic network capture so the SDK can exclude its own request. Without it, automatic network capture is disabled. Pass `signal` so timeout and teardown can abort the request. A custom transport's thrown error is retryable, so account for that in your backend. Never put server secrets in browser configuration. See the [v1 contract](integration.md) and [backend guide](server-request.md).

The SDK observes global JavaScript exceptions, unhandled promises, fetch/XHR failures, and HTTP 5xx by default. Override HTTP status selection with `shouldCaptureHttp`; `console.error` capture is opt-in. It strips URL query strings, fragments, and user information and masks common sensitive patterns. It does not capture request/response bodies, cookies, input values, or DOM snapshots. These rules cannot identify every sensitive value. Add path-specific `sanitizeUrl(url)` and discard or edit records in `beforeSend(event)`; a throwing hook drops that event.

Delivery is best-effort: the default queue holds at most 50 events, batches have size limits, each attempt defaults to a five-second timeout, and retryable failures receive at most two retries. `transportTimeoutMs` accepts 250 to 60,000 ms. An uncooperative custom transport may continue outside the SDK after its timeout. Offline periods, tab closure, and queue overflow can lose events. Retries keep the same event ID; the backend should deduplicate it. `viewId` identifies an SDK instance, not a tracked user session.
