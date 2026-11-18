# Browser and React integration

## Package and lifecycle

Use `@ihyeon/browser-error-log` for browser/WebView JavaScript. React is optional: only add `@ihyeon/browser-error-log-react` when render-error handling is requested. The adapter's peer range is React `>=18 <20`; inspect the installed metadata before choosing a version. The SDK also depends on `@ihyeon/browser-error-log-protocol`.

Inspect the app bootstrap, routing, SSR/client boundary, HMR cleanup, and an existing collector before editing. Importing the SDK on the server is safe but creates an inert client, not server monitoring. Initialize on the client, once per intended lifetime, and do not retain a server-created client for browser use.

This example runs in an app's **browser startup**. `/api/events` is illustrative: use it only if the app has that ingest route, otherwise substitute the authorized collector URL. Preserve the real project/environment/release values supplied by the app.

```ts
import { init } from '@ihyeon/browser-error-log';

const errors = init({
  project: 'my-app',
  endpoint: '/api/events',
  environment: 'development',
  release: 'local-smoke',
  preset: 'minimal',
  deliveryStatusLimit: 20,
});

errors.addBreadcrumb({ category: 'action', message: 'Synthetic save click' });
const eventId = errors.captureException(new Error('Synthetic integration check'), {
  context: { screen: 'integration-fixture' },
});
await errors.flush();
const diagnostics = errors.getDiagnostics();
const delivery = eventId ? errors.getDeliveryStatus(eventId) : { state: 'unknown' };
// Check the authorized collector for (project, eventId), not just diagnostics.sent.
// At app/HMR teardown, after any intended flush:
errors.destroy();
```

`init()` infers `BrowserErrorLogDeliveryClient`. Older interfaces intentionally retain their shapes; use the inferred return type or `BrowserErrorLogCaptureClient` when a caller needs the returned ID. A filtered, duplicated, or rejected event may return `undefined`.

The optional `deliveryStatusLimit` retains at most 100 recently admitted IDs in this client's memory; it defaults to zero. `getDeliveryStatus(id)` is available on the inferred `BrowserErrorLogDeliveryClient` return type. `queued` and `in-flight` describe SDK work, `transport-accepted` means HTTP 2xx or a resolved custom transport, `beacon-queued` means `sendBeacon()` accepted browser queue work, and `dropped` includes the SDK drop reason. `unknown` includes disabled tracking, unknown IDs, and entries evicted from this bounded history. Neither accepted state proves durable storage. Keep the actual collector lookup in the verification step.

## Collection choices

| Default within preset | minimal | standard | detailed |
| --- | --- | --- | --- |
| Explicit capture/breadcrumb and normal delivery | on | on | on |
| Automatic global JS errors, unhandled rejections, fetch/XHR failures and HTTP 5xx | off | on | on |
| Console/resource errors, navigation/network breadcrumbs, Error.cause | off | off | on |
| Error and component stacks | off | on | on |

Use real booleans for overrides. Examples: `preset: 'minimal', captureStack: true` retains manual stacks; `preset: 'detailed', captureConsole: false` excludes console capture. `undefined` leaves the preset value, and `enabled: false` disables the client. Changing options after initialization does not reconfigure it.

Sampling (`sampleRate`), a rolling per-client admission budget (`maxEventsPerMinute`), message suppression (`ignoreMessages`), value deduplication (`dedupeIntervalMs`), queue/batch limits, offline handling, and flush timing are independent controls. Presets do not tune them. Select them from actual product requirements, not the benchmark defaults.

The in-memory queue defaults to 50 events and clamps at 100. Delivery batches default to 20 events and are bounded by 48,000 bytes. Smaller batches can increase request count. Keep pre-send hooks bounded; a custom transport must honor its abort signal. If a custom transport should retain automatic network capture, also supply `endpoint` so collector requests are excluded.

## React

The optional `ErrorBoundary` accepts `client`, children, and a React node or `(error, reset) => ReactNode` fallback. Use an existing browser client in the appropriate client component or bootstrap. Example wrapper after that client exists:

```tsx
import { ErrorBoundary } from '@ihyeon/browser-error-log-react';

const protectedView = (
  <ErrorBoundary client={errors} fallback={<p>This view failed.</p>}>
    <App />
  </ErrorBoundary>
);
```

`App` is the consumer's component. This handles React render errors passed to `componentDidCatch`; handled exceptions still use manual capture. A minimal preset also omits React component stacks unless explicitly enabled. It does not monitor native crashes or server exceptions.

## Verification and interpretation

- Match an admitted ID with an actual collector record and compare its optional delivery status plus `queued`, `inFlight`, `sent`, `dropped`, `filtered`, and `deduplicated` around the synthetic run.
- Default HTTP transport omits credentials. Do not assume an existing cookie-authenticated endpoint will accept it. Use the product's intended ingest design.
- Do not reuse the same Error object for repeated smoke events: object identity is deduplicated.
- `captureStack: false` omits stack/componentStack even if a pre-send hook tries to restore them. It does not scrub arbitrary text from custom context or manual breadcrumb messages.
- Privacy filtering is best effort. Restrict app-supplied context to necessary scalar fields and avoid real personal data in examples.
