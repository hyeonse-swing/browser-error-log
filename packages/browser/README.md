# @browser-error-log/browser

A small browser error SDK for a collector you control. Use your own backend or the repository's self-hosted Node.js collector, which stores events in SQLite or rotating JSONL files.

**Release status:** this is a source preview, not a published npm release. Package names are provisional, `private: true` is still enabled, and the open-source license has not been selected. Registry installation will become available only after a release.

## Why use it?

- **Choose where events go.** There is no built-in hosted endpoint or separate analytics destination. Configure `endpoint` or supply your own `transport`.
- **Keep the browser dependency small.** No runtime framework dependency; ESM, CommonJS, and TypeScript declarations are provided. The repository enforces a 20 KiB gzip budget for the browser SDK, excluding the viewer and optional React adapter.
- **Control events before delivery.** Filter or edit them with `beforeSend`, remove path identifiers with `sanitizeUrl`, and choose which HTTP responses matter with `shouldCaptureHttp`.
- **Start with useful error context.** Collect JavaScript exceptions, unhandled promises, fetch/XHR failures, and manually reported errors, with project, release, page, and occurrence time. Console capture is opt-in.
- **Keep storage portable.** The companion collector offers SQLite with a live viewer, or JSONL logs that can be exported and inspected locally. You can implement the same versioned contract in your own backend.

## Install the current preview

In a source checkout, use Node.js 24 and npm:

```sh
npm ci
npm run check:package
```

This builds and verifies the local packages and writes tarballs to `output/packages/`. In your web app, install both tarballs together, replacing `/path/to/browser-error-log` with the absolute path to the checkout:

```sh
npm install /path/to/browser-error-log/output/packages/browser-error-log-protocol-0.1.0.tgz /path/to/browser-error-log/output/packages/browser-error-log-browser-0.1.0.tgz
```

After an npm release under this package name, the equivalent registry command will be `npm install @browser-error-log/browser`. It is not the installation path for this unpublished preview.

## Connect in three steps

1. In the source checkout, start your collector. Set the exact origin of the app that will send events:

   ```sh
   MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run micro
   ```

2. In your app's browser entry point, initialize once:

   ```ts
   import { init } from '@browser-error-log/browser';

   export const errorLog = init({
     project: 'my-web',
     endpoint: 'http://127.0.0.1:4319/api/events',
     environment: 'development',
     release: 'my-release',
   });
   ```

3. Send a diagnostic error, then open `http://127.0.0.1:4319/`:

   ```ts
   errorLog.captureException(new Error('Connection check'));
   await errorLog.flush();
   console.log(errorLog.getStats()); // sent: 1 when delivery succeeds
   ```

Keep the client alive for the app's lifetime. Use `destroy()` for test cleanup or when disposing the app; it removes instrumentation and discards pending events. `flush()` completes the SDK's delivery attempts, not a guarantee of storage: check `getStats()` and the collector. Capturing starts only after initialization.

Use the repository's `docs/micro-server.md` for external hosting. Production apps need their own HTTPS collector, exact allowed origins, persistent storage, and viewer authentication. `localhost` and `127.0.0.1` are different origins. The viewer password belongs only on the server; do not put it in SDK configuration.

## Capture handled errors

```ts
try {
  await loadDashboard();
} catch (error) {
  errorLog.captureException(error, { context: { action: 'load-dashboard' } });
}
```

The optional `@browser-error-log/react` package provides an Error Boundary. The base SDK does not require React. Imports and initialization are safe during SSR but do not collect server-side errors; initialize in your framework's browser/client entry point.

## Collection controls

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events', // your collector or a same-origin proxy
  captureConsole: false,
  beforeSend(event) {
    if (event.message.includes('Expected diagnostic')) return null;
    return event;
  },
  sanitizeUrl(url) {
    return url.replace(/\/users\/[^/?#]+/g, '/users/:id');
  },
  shouldCaptureHttp(status) {
    return status >= 500;
  },
});
```

By default, HTTP capture records 5xx responses and network failures, excludes intentional aborts, and excludes the collector endpoint. The SDK strips URL queries, fragments, and credentials and masks common email/token patterns. It does not collect request/response bodies, cookies, DOM, form inputs, or session recordings. Error text, URL paths, stacks, and custom context may still contain sensitive data; set application-specific filters. A failing `beforeSend` or `sanitizeUrl` drops the event.

For a custom `transport(batch, { signal })`, pass `signal` to your request and reject on delivery failure. Include `endpoint` for collector exclusion if you want automatic network capture; otherwise network capture is disabled for a custom transport. The default transport omits credentials.

## Delivery limits

The default queue holds 50 events and flushes every 10 seconds. Batches contain up to 20 events or 48,000 bytes. Each attempt has a 5-second deadline; retryable failures get up to two retries. `maxQueueSize`, `flushIntervalMs`, and `transportTimeoutMs` are configurable within bounded ranges. These are best-effort limits: offline operation, tab closure, buffer overflow, or exhausted retries can lose events. There is no persistent offline queue or exactly-once guarantee.

## Hosting and costs

This project distributes software, not a managed monitoring service. Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers. Self-hosting does not mean that your infrastructure is free.
