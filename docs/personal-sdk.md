# Install and connect the browser SDK

English | [한국어](ko/personal-sdk.md)

The SDK accepts an `endpoint` or a custom `transport`. React is optional. For persistent storage, start with the [self-hosting guide](micro-server.md).

The browser SDK, protocol, and React adapter are separate npm packages under `@ihyeon`; see the [release guide](releasing.md) for verified release history. Install the browser SDK in the consuming app:

```sh
npm install @ihyeon/browser-error-log
```

For an existing React 18/19 app, install the browser SDK and optional React adapter:

```sh
npm install @ihyeon/browser-error-log @ihyeon/browser-error-log-react
```

For ordinary app integration, you do not need a separate protocol install. `@ihyeon/browser-error-log-protocol` is installed automatically with the SDK and contains the shared event types and constants. Install it directly only when importing those contracts in your own collector or viewer. It is not an error collector or a server.

The English/Korean selector is part of the viewer, demo, and install example built from this repository. Installing the SDK alone does not add a language selector to your app. The v1 event schema is unchanged; `sdkVersion` identifies the installed SDK release.

## Optional: build local tarballs from source

Use Node.js 24 and npm from the repository root:

```sh
npm ci
npm run check:package
```

The script builds three tarballs for the checkout's version in `output/packages/` and installs them into isolated consumers to check standalone protocol use, browser-only installation without React, TypeScript declarations, ESM/CJS exports, and SSR imports. This path is for local development and does not publish anything.

In the consuming app, replace `SDK_DIR` with this checkout's absolute path:

```sh
SDK_DIR="/absolute/path/to/browser-error-log"
SDK_VERSION="$(node -p 'require(process.argv[1]).version' "$SDK_DIR/package.json")"
npm install "$SDK_DIR/output/packages/ihyeon-browser-error-log-protocol-$SDK_VERSION.tgz" \
  "$SDK_DIR/output/packages/ihyeon-browser-error-log-$SDK_VERSION.tgz"
```

For an existing React 18/19 app, add the adapter in the same install:

```sh
SDK_DIR="/absolute/path/to/browser-error-log"
SDK_VERSION="$(node -p 'require(process.argv[1]).version' "$SDK_DIR/package.json")"
npm install "$SDK_DIR/output/packages/ihyeon-browser-error-log-protocol-$SDK_VERSION.tgz" \
  "$SDK_DIR/output/packages/ihyeon-browser-error-log-$SDK_VERSION.tgz" \
  "$SDK_DIR/output/packages/ihyeon-browser-error-log-react-$SDK_VERSION.tgz"
```

The browser package does not require React. These packages export ESM, CommonJS, and TypeScript declarations for app bundlers; they do not provide a CDN global script.

For a collector or viewer that only needs the contracts, install just the protocol tarball:

```sh
npm install "$SDK_DIR/output/packages/ihyeon-browser-error-log-protocol-$SDK_VERSION.tgz"
```

## Connect to the included collector

For an app at `http://localhost:5173`, start the SQLite collector in this repository:

```sh
MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run micro
```

The exact origin must match, including hostname and port; `localhost` and `127.0.0.1` are different origins. Initialize once in the consuming app's browser entry point:

```ts
import { init } from '@ihyeon/browser-error-log';

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

### Choose a capture mode

`preset` lets you start with one of three capture levels. Omit it for `standard`, which retains the previous defaults. These levels change runtime instrumentation and, in `minimal`, the data included in each event; they use the same SDK package and do **not** produce different download bundles.

| Capture switch | `minimal` | `standard` (default) | `detailed` |
| --- | --- | --- | --- |
| Global JavaScript errors / unhandled promises | Off / off | On / on | On / on |
| fetch/XHR errors (`captureNetwork`) | Off | On | On |
| `console.error` / resource load errors | Off / off | Off / off | On / on |
| Navigation / network breadcrumbs | Off / off | Off / off | On / on |
| Linked `Error.cause` details / stack and component stack | Off / off | Off / on | On / on |

`minimal` still accepts explicit `captureException()` and `addBreadcrumb()` calls. Accepted manual events use the normal flush timer and page lifecycle delivery; you do not have to call `flush()` after every error. `captureStack: false` omits `stack` and `componentStack`, does not read error/cause stack properties, and prevents `beforeSend` from reintroducing those fields. The message, name, required event metadata, explicit context, and manual breadcrumbs remain available. If you need a stack in minimal mode, set `captureStack: true`.

```ts
const errorLog = init({
  project: 'my-web', endpoint: '/monitoring/events',
  preset: 'minimal',
  captureGlobalErrors: true, // Override only this automatic hook.
  captureStack: true,        // Keep stack details for accepted errors.
});
```

Each explicit capture boolean overrides its mode; `false` wins in `detailed`, while `undefined` inherits the mode. The choice is fixed for that client at `init()`. To change modes, flush if needed, destroy the old client, and initialize a new one. `enabled: false` remains the master off switch. With a custom transport, automatic fetch/XHR capture and breadcrumbs still require `endpoint` so the SDK can exclude collector requests.

`detailed` can observe more browser activity and include extra diagnostic text, which may increase runtime work and expose more app context to review. It retains the existing sanitization and limits; it never collects request/response bodies, input values, cookies, or DOM snapshots. `sampleRate`, `maxEventsPerMinute`, `dedupeIntervalMs`, `ignoreMessages`, `maxQueueSize`, `maxBatchSize`, and `flushIntervalMs` are independent controls and are not changed by a preset. Choose them explicitly for volume and delivery policy. The [preset benchmark (Korean)](preset-performance-2026-11-17.ko.md) records local CPU, JS heap, renderer RSS, and collector payload measurements for public version 0.2.13. These workload-specific measurements are not application-wide savings guarantees.

| Option | Default | Purpose |
| --- | --- | --- |
| `project` | Required | Group events under a project; match the collector's allowlist |
| `endpoint` | None | Collector URL; required unless using `transport` |
| `transport` | Built-in fetch transport | Send `EventBatch` with an abort `signal`; reject on failure |
| `environment` / `release` | `development` / `unknown` | Label the deployment and build |
| `runtime` | `browser` | `browser`, `webview-ios`, `webview-android`, or `unknown`; a label, not native instrumentation |
| `enabled` | `true` | Disable collection with `false` |
| `preset` | `standard` | Select `minimal`, `standard`, or `detailed` runtime capture defaults |
| `captureStack` | `true` (`minimal`: `false`) | Include sanitized error and component stacks |
| `captureNetwork` | `true` | Observe fetch/XHR; a custom transport also needs `endpoint` |
| `captureConsole` | `false` | Opt in to `console.error` capture |
| `captureGlobalErrors` / `captureUnhandledRejections` | `true` / `true` | Automatic global JavaScript and promise hooks |
| `captureResourceErrors` / `captureNavigation` / `captureNetworkBreadcrumbs` / `captureErrorCause` | `false` | Optional resource, navigation, network trail, and linked cause context |
| `sampleRate` / `maxEventsPerMinute` / `dedupeIntervalMs` / `ignoreMessages` | `1` / no limit / `0` / none | Sampling, rate cap, duplicate suppression, literal message filter |
| `maxBatchSize` | `20` | Maximum events per delivery batch; clamped to 1–20 |
| `shouldCaptureHttp` | 5xx responses | Select HTTP statuses to capture |
| `sanitizeUrl` | Built-in URL cleanup | Remove application-specific path identifiers before the built-in cleanup |
| `beforeSend` | No custom filter | Edit an event or return `false`/`null` to drop it |
| `flushIntervalMs` | `10000` | Flush interval in ms; clamped to 10–60,000 |
| `maxQueueSize` | `50` | Buffered events; clamped to 1–100 |
| `deliveryStatusLimit` | `0` | Recent IDs retained for per-event SDK status; clamped to 0–100 |
| `transportTimeoutMs` | `5000` | Per-attempt deadline in ms; clamped to 250–60,000 |

The client exposes `captureException(error, extra?)`, `flush()`, `getStats()`, and `destroy()`. `extra` can include `context`, `componentStack`, and an event `type`. The `init()` return type (`BrowserErrorLogDeliveryClient`) exposes a `string | undefined` result from `captureException`: the event ID is returned when the event enters the SDK queue and remains the same across retries; a filtered, deduplicated, limited, disabled, or failed candidate returns `undefined`. The existing `BrowserErrorLogClient` and `BrowserErrorLogDiagnosticsClient` interfaces retain their `void` method signatures for existing adapters. An ID is not evidence of collector storage: a queued event may be evicted, fail delivery, or be lost on page closure. `getStats()` returns `queued`, `sent`, and `dropped` counts. `sent` includes events accepted by the browser's `sendBeacon` queue when the tab is hidden, without confirming collector storage. A resolved `flush()` means delivery attempts have finished, including failures; it does not itself confirm success. `destroy()` cancels SDK work and discards pending events. Do not call it immediately after normal initialization.

`init()` now returns `BrowserErrorLogDeliveryClient`, which extends the earlier capture-client interface without changing its shape. Set `deliveryStatusLimit` to a positive number to retain up to 100 recent IDs on that client; the default is zero. `getDeliveryStatus(eventId)` distinguishes `queued`, `in-flight`, `transport-accepted`, `beacon-queued`, `dropped` (with a drop reason), and `unknown`. A resolved custom transport or HTTP 2xx is transport acceptance, not proof of server persistence. A successful `sendBeacon()` call only queues work in the browser. An unknown status also covers disabled tracking, an ID from another client, or a history entry evicted by the limit. Only IDs and states are held in memory, and the oldest admitted entry is removed first. Check the collector for the same project and ID when storage confirmation matters.

## React and SSR

Reuse the same client with the React adapter:

```tsx
import { ErrorBoundary } from '@ihyeon/browser-error-log-react';
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

Delivery is best-effort: the default queue holds at most 50 events, batches have size limits, each attempt defaults to a five-second timeout, and retryable failures receive at most two retries. `transportTimeoutMs` accepts 250 to 60,000 ms. An uncooperative custom transport may continue outside the SDK after its timeout. Built-in fetch requests use `keepalive` so a batch already in flight can continue after page navigation, subject to the browser's keepalive quota. If the browser rejects that request without an HTTP response, the next retry uses a regular fetch so quota exhaustion does not block active-page delivery. On a same-origin page hide or leave, the built-in transport attempts capped beacon batches from the queue. On page leave it also backs up an in-flight fetch with the same event IDs; the collector must deduplicate if both requests arrive. It stops if the browser rejects a batch; unsent events remain queued only while the page survives. A beacon acceptance is not collector receipt. Offline periods, tab closure, and queue overflow can lose events. Retries keep the same event ID; the backend should deduplicate it. `viewId` identifies an SDK instance, not a tracked user session.
