# @ihyeon/browser-error-log

English | [한국어](https://github.com/hyeonse-swing/browser-error-log/blob/main/packages/browser/README.ko.md)

A small browser error SDK for a collector you control. Use your own backend or the repository's self-hosted Node.js collector, which stores events in SQLite or rotating JSONL files.

## Why use it?

- **Choose where events go.** There is no built-in hosted endpoint or separate analytics destination. Configure `endpoint` or supply your own `transport`.
- **Keep the browser dependency small.** No runtime framework dependency; ESM, CommonJS, and TypeScript declarations are provided. The repository enforces a 20 KiB gzip budget for the browser SDK, excluding the viewer and optional React adapter.
- **Control events before delivery.** Filter or edit them with `beforeSend`, remove path identifiers with `sanitizeUrl`, and choose which HTTP responses matter with `shouldCaptureHttp`.
- **Start with useful error context.** Collect JavaScript exceptions, unhandled promises, fetch/XHR failures, and manually reported errors, with project, release, page, and occurrence time. Console capture is opt-in.
- **Keep storage portable.** The companion collector offers SQLite with a live viewer, or JSONL logs that can be exported and inspected locally. You can implement the same versioned contract in your own backend.

## Install

```sh
npm install @ihyeon/browser-error-log
```

The `@ihyeon/browser-error-log-protocol` dependency resolves from npm. For local source-checkout development, use Node.js 24, `npm ci`, and `npm run check:package`, then install the protocol and browser tarballs together as shown in the [SDK guide](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/personal-sdk.md).

## Connect in three steps

1. In the source checkout, start your collector. Set the exact origin of the app that will send events:

   ```sh
   MICRO_PROJECTS=my-web MICRO_ALLOWED_ORIGINS=http://localhost:5173 npm run micro
   ```

2. In your app's browser entry point, initialize once:

   ```ts
   import { init } from '@ihyeon/browser-error-log';

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

Keep the client alive for the app's lifetime. Use `destroy()` for test cleanup or when disposing the app; it removes instrumentation and discards pending events. `flush()` completes the SDK's delivery attempts, not a guarantee of storage: check `getStats()` and the collector. `sent` also counts events accepted by the browser's `sendBeacon` queue when the tab is hidden; this does not confirm collector storage. Capturing starts only after initialization.

Use the [self-hosting guide](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/micro-server.md) for external hosting. Production apps need their own HTTPS collector, exact allowed origins, persistent storage, and viewer authentication. `localhost` and `127.0.0.1` are different origins. The viewer password belongs only on the server; do not put it in SDK configuration.

## Capture handled errors

```ts
try {
  await loadDashboard();
} catch (error) {
  errorLog.captureException(error, { context: { action: 'load-dashboard' } });
}
```

The optional `@ihyeon/browser-error-log-react` package provides an Error Boundary. The base SDK does not require React. Imports and initialization are safe during SSR but do not collect server-side errors; initialize in your framework's browser/client entry point.

## Include linked error causes

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  captureErrorCause: true,
});

const cause = new TypeError('Invalid response');
errorLog.captureException(new Error('Dashboard could not load', { cause }));
```

This opt-in setting follows up to four linked `cause` objects and appends their names, messages, and available stacks as `Caused by:` sections in the existing `stack` field. The outer error keeps its original name and message; causes do not produce separate events or consume additional rate-limit capacity. Manual, global, promise, and React captures use this path. With console capture enabled, it also applies to the first existing same-window Error argument. Automatic network error events keep their existing metadata-only behavior.

Only objects with a string `message` or `stack` are followed, including Error objects from another window. Primitive causes, other object payloads, and `AggregateError.errors` are not expanded. Cycles and inaccessible properties stop or omit cause information without affecting the app. The option is disabled by default and is fixed at initialization; disabled capture does not read `cause`.

When a valid cause is present, the outer stack uses up to 2,048 characters and each cause section up to 480, within the existing 4,096-character total stack limit. The existing text/URL filters run before section clipping. No new protocol fields or collector upgrade are needed, and existing viewer stack details show the chain. Review application-specific filters before opting in: cause messages and paths can contain additional sensitive data. `beforeSend` can edit the combined stack, remove it with `delete event.stack` or `event.stack = undefined`, or reject the event. A failing URL sanitizer drops the event rather than sending unfiltered cause data.

## Capture failed resource loads

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  captureResourceErrors: true,
});
```

**Upgrade your collector and viewer to 0.2.0 or later before enabling this option.** Custom backends must accept `type: 'resource'` in their schema and type filters. Older collectors can reject an entire batch containing the new type. The option is off by default, so ordinary existing event types remain usable with older collectors.

The SDK observes current-document loading errors from scripts, stylesheet links, and images after initialization. Events use type `resource`, name `ResourceLoadError`, a fixed message such as `Failed to load script resource`, and scalar `context.resourceTag` (`script`, `link`, or `img`) and `context.resourceUrl`. The image's selected `currentSrc` is used when available. Only HTTP(S) URLs are recorded, using the existing URL/text filters and context limits. HTML, element text, IDs, classes, alternate text, form values, and source-set lists are not copied. Collector URLs and unsupported resource kinds/schemes are excluded.

Element error events do not expose an HTTP status or response body. These events therefore have no invented status, network timing, or stack. A failed load can have several causes, including a missing file, browser policy, or image decoding. Requests are not repeated or probed. The setting is independent of fetch/XHR capture; native element handlers and default behavior are preserved. Errors before initialization, inside other documents, or behind event boundaries that do not reach the window are not recovered.

Resource events share normal context, breadcrumbs, `beforeSend`, rate limits, queue limits, and diagnostics. The two resource context fields take priority over common context within the existing 12-field limit. URL or context hook failures drop the event; a `beforeSend` veto filters it. `destroy()` removes the listener. Viewer type filters, charts, details, and history JSON support the new type in 0.2.0.

## Record the steps before an error

```ts
errorLog.addBreadcrumb({ category: 'navigation', message: 'Checkout opened' });
errorLog.addBreadcrumb({ category: 'action', message: 'Order submitted', data: { paymentMethod: 'card', attempt: 1 } });
errorLog.captureException(new Error('Order could not be completed'));
errorLog.clearBreadcrumbs(); // start a new flow; captured errors keep their snapshot
```

Each client keeps the latest 20 recorded steps, within a 12,000-byte UTF-8 JSON budget. Adding a step does not send a separate event; subsequent errors include an oldest-first snapshot. Steps have an SDK-generated UTC timestamp, a category (default `manual`, up to 40 characters), a message (up to 256 characters), and optional scalar data (six keys, 80 characters per key and 200 per string value). The existing sensitive-key, URL, and text filters apply; `beforeSend` can edit or remove `event.breadcrumbs`. `clearBreadcrumbs()` affects future captures, and `destroy()` also clears the local trail.

`init()` returns `BrowserErrorLogDiagnosticsClient`, extending `BrowserErrorLogBreadcrumbClient` and the original `BrowserErrorLogClient`. Existing clients and React Error Boundary mocks can keep their original interfaces; use the corresponding extended type when explicitly typing a client that calls breadcrumb or diagnostic methods.

The viewer shows these steps in both error detail views and preserves them in history JSON. Use a collector and viewer with breadcrumb support (introduced in 0.1.16) to retain and display this optional field; older collectors may accept an event while omitting its breadcrumbs. Custom backends can validate the trail with `isBreadcrumbTrail` from `@ihyeon/browser-error-log-protocol`.

## Filter steps before they are stored

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  captureNetworkBreadcrumbs: true,
  beforeBreadcrumb(breadcrumb) {
    const url = breadcrumb.data?.url;
    if (breadcrumb.category === 'http' && typeof url === 'string' && url.endsWith('/api/health')) return null;
    if (breadcrumb.category === 'manual') breadcrumb.category = 'action';
    return breadcrumb;
  },
});
```

The synchronous `beforeBreadcrumb` hook runs once when a valid manual, navigation, or network step is created, after initial SDK sanitization and before local trail storage. Return `false` or `null` to omit the step, return a `BreadcrumbInput` replacement, or return nothing to keep changes to the supplied copy. Returned content is sanitized again with the existing limits. The SDK keeps its original occurrence time and ignores extra fields.

The hook receives independent copies; retaining or changing them later does not rewrite the live trail or queued error snapshots. A throwing hook, invalid replacement, or replacement sanitization failure omits that step without changing error counters. Filtering a network breadcrumb does not suppress the corresponding standalone HTTP/network error; use `captureNetwork`, `shouldCaptureHttp`, or `beforeSend` for error selection. Nested breadcrumb creation during this hook is ignored, and a hook that destroys its client cannot add a step afterward.

The hook is not called again when errors snapshot a trail, during `beforeSend` replacement sanitization, on reads, or on delivery/retries. `beforeSend` remains the final event filter. No additional event, request, protocol field, or collector upgrade is required for this hook.

## Automatically record SPA navigation

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  captureNavigation: true,
});
```

This opt-in setting records current-window, same-document navigation through `history.pushState`, `history.replaceState`, and back/forward events. Each `navigation` breadcrumb contains filtered `from`/`to` URLs and its `trigger`. The default URL policy removes credentials, queries, and fragments; changes that produce the same filtered URL do not add a step. Hash-only routers therefore need explicit manual breadcrumbs or application-specific context.

Capture starts after initialization and shares the same 20-step/12,000-byte trail as manual steps. `clearBreadcrumbs()` starts a fresh trail for future errors; recording resumes on the next navigation. The trail stays in memory for this document and does not carry across a full page load. History state and title arguments are not copied into breadcrumbs. `sanitizeUrl` and `beforeSend` keep their existing controls, and `destroy()` removes this client's instrumentation. Host-locked or replaced History methods can prevent navigation capture.

## Automatically record network activity

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  captureNetworkBreadcrumbs: true,
});
```

This opt-in setting records completed fetch/XHR responses, including 2xx/4xx/5xx, and real transport failures in the same bounded trail. Response entries use category `http`, message `HTTP response`, and scalar `data.method`, `data.url`, `data.durationMs`, and `data.status`. Transport failures use category `network`, message `Network failure`, and omit status. A browser may report status `0` for an opaque response; the viewer shows unavailable status accordingly. URLs use the existing filters and are limited to 200 characters. Bodies, headers, and failure messages are not copied into these entries; intentional aborts and collector requests are excluded.

Requests are recorded when they finish, in completion order; in-flight requests are not yet part of an error's snapshot. Recording a request does not send another event or increase error counters. `captureNetwork` and `shouldCaptureHttp` continue to control standalone error events: set `captureNetwork: false` if you want network context without automatic HTTP/network error events. A false status predicate does not remove request breadcrumbs; filter those with `beforeSend`. A throwing predicate still drops that request's reporting when standalone capture is enabled. `clearBreadcrumbs()` resets the shared 20-step/12,000-byte trail for future captures.

With a custom transport, supply its collector `endpoint` for exclusion; without it, both automatic network channels are disabled. These entries use the existing breadcrumb contract and work with collectors/viewers supporting breadcrumbs since 0.1.16.

## Collection controls

```ts
let currentAppSection = 'checkout';

const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events', // your collector or a same-origin proxy
  context: { buildChannel: 'stable' },
  getContext: () => ({ appSection: currentAppSection }),
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

currentAppSection = 'account'; // subsequent events use the current value
```

Set `context` at initialization to attach common diagnostic fields to every event, including automatic captures. Use the synchronous `getContext` callback to read current app state once per captured event; returning `undefined` adds no dynamic fields. Per-error `captureException(error, { context })` values take priority over `getContext`, followed by initialization `context`, within the limit of 12 scalar fields. The same sensitive-key, URL, and text filters apply, and `beforeSend` can edit or remove the combined context. Already queued events keep their captured values. A throwing `getContext` drops that event without affecting the app.

Set `captureConsole: true` to capture `console.error` calls. The combined message is preserved; the first `Error` created in the current window also contributes its name and stack, using the same redaction and `beforeSend` controls.

By default, HTTP capture records 5xx responses and network failures, excludes intentional aborts, and excludes the collector endpoint. The SDK strips URL queries, fragments, and credentials and masks common email/token patterns. It does not collect request/response bodies, cookies, page HTML, element text, form inputs, or session recordings. Error text, URL paths, stacks, and custom context may still contain sensitive data; set application-specific filters. A failing `beforeSend` or `sanitizeUrl` drops the event.

For a custom `transport(batch, { signal })`, pass `signal` to your request and reject on delivery failure. Include `endpoint` for collector exclusion when using automatic network error capture or network breadcrumbs; otherwise both are disabled for a custom transport. The default transport omits credentials.

## Limit error bursts

```ts
const errorLog = init({
  project: 'my-web',
  endpoint: '/api/events',
  maxEventsPerMinute: 60,
});
```

`maxEventsPerMinute` optionally caps new events admitted to each client's queue over the preceding 60 seconds. It is disabled by default. Finite values are rounded down and clamped to 1–1,000; omitted or non-finite values disable the limit. All error types share the same budget, including manual and React captures, global errors, promises, console, and selected HTTP/network failures. Excess events are discarded immediately and increase `getStats().dropped`; they are not delayed for later delivery. Capacity returns as each admitted event reaches 60 seconds of age.

Flushing an empty queue does not reset the budget. Retries and beacon delivery reuse admitted events without consuming more capacity; breadcrumbs do not consume it. Duplicate Error objects and events filtered by `beforeSend` do not consume capacity. Once the budget is full, `beforeSend` is skipped for excess events. Admitted events still consume capacity if they are later evicted from the queue or fail delivery.

The budget belongs to this client in the current document; a new client or full page load starts a new one. It limits queue admission, not HTTP request counts, bytes, server-wide traffic, or the work done to construct an event. Use independent server-side limits for your collector.

## Inspect SDK collection and delivery

```ts
await errorLog.flush();
const diagnostics = errorLog.getDiagnostics();
console.log(diagnostics.inFlight, diagnostics.filtered, diagnostics.deduplicated);
console.table(diagnostics.droppedByReason);
```

`getDiagnostics()` returns the existing `queued`, `sent`, and `dropped` counts, plus `inFlight` (events in a delivery batch, including retry waits), `filtered` (`beforeSend` returned `false` or `null`), `deduplicated` (the existing same-object suppression in `captureException`), and these drop reasons:

| `droppedByReason` key | Events counted |
| --- | --- |
| `rateLimit` | Rejected by `maxEventsPerMinute` |
| `queueOverflow` | Evicted from a full queue |
| `payloadTooLarge` | Exceeded the event or batch byte budget |
| `processingError` | Dropped by an observed preprocessing, sanitizer, or callback failure |
| `deliveryError` | Failed permanently or exhausted delivery retries |
| `destroyed` | Discarded from the queue or an active delivery by `destroy()` |

The reason counts sum to `dropped`. `filtered` and `deduplicated` are separate and preserve the existing `getStats()` behavior. Retry attempts do not count as dropped events unless delivery finally fails; a failed beacon attempt keeps the queue. `sent` retains its best-effort meaning, including browser beacon-queue acceptance rather than proof of collector storage.

Each call returns independent copies containing only local counters. It does not send events, invoke capture hooks, or include URLs, error text, or payloads. Counts belong to this client for its lifetime, remain readable after `destroy()` (with `inFlight: 0`), and are not reset by flush or breadcrumb cleanup. Disabled/SSR clients start with zero counts. Excluded collector requests, intentional aborts, unselected HTTP statuses, and ignored breadcrumb input do not increment these counters. These counters cover SDK-observed decisions, not errors before initialization or proof of complete server ingestion. No collector upgrade is needed, and `getStats()` keeps its original three-field shape.

## Delivery limits

The default queue holds 50 events and flushes every 10 seconds. Batches contain up to 20 events or 48,000 bytes. Each attempt has a 5-second deadline; retryable failures get up to two retries. `maxQueueSize`, `flushIntervalMs`, and `transportTimeoutMs` are configurable within bounded ranges. These are best-effort limits: offline operation, tab closure, buffer overflow, or exhausted retries can lose events. There is no persistent offline queue or exactly-once guarantee.

## Hosting and costs

This project distributes software, not a managed monitoring service. Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers. Self-hosting does not mean that your infrastructure is free.
