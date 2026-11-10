# v1 integration contract

English | [한국어](ko/integration.md)

This is the current browser SDK and viewer contract. The included [micro server](micro-server.md) implements it with SQLite. Operators can also build a backend using the types in `packages/protocol`.

## Ingest events

The default SDK sends `POST application/json` to its configured `endpoint` with `credentials: 'omit'`. The body is an `EventBatch`:

```json
{
  "schemaVersion": 1,
  "events": [{
    "schemaVersion": 1,
    "eventId": "stable-generated-id",
    "project": "my-web",
    "environment": "staging",
    "release": "build-id",
    "sdkVersion": "<installed-sdk-version>",
    "occurredAt": "2026-10-02T07:00:00.000Z",
    "viewId": "document-instance-id",
    "sequence": 1,
    "elapsedMs": 1500,
    "type": "javascript",
    "message": "Example error",
    "page": "https://example.invalid/products",
    "runtime": "browser"
  }]
}
```

`sdkVersion` is a placeholder in this example; the SDK sets it to its installed package version. Optional fields are `name`, `stack`, `componentStack`, `browser`, `context`, and `network`. Context values are strings, finite numbers, booleans, or null. Network data contains `method`, `url`, `durationMs`, and optionally `status`. Event times use ISO UTC; the server may add `receivedAt`. `project` and `Origin` are public client claims, not authentication.

Optional `breadcrumbs` preserves up to 20 recorded steps (12,000 UTF-8 JSON bytes) in recording order. Each entry has canonical UTC `occurredAt`, `category` (40 characters), `message` (256), and optional scalar `data` (six keys, key length 80, string length 200). Validate with `isBreadcrumbTrail` from the protocol package and retain the field through storage and JSON export. This is an additive schema-v1 field: upgrade self-hosted collectors/viewers to preserve it; older persistent collectors may omit it. SDK filtering is best-effort; the protocol validator checks structure and bounds, not sensitive content.

A 2xx response acknowledges the whole batch; the SDK ignores its body. It retries 429, 5xx, and network failures up to twice after the first attempt, with the same event IDs. Other 4xx responses are permanent failures. The default per-attempt timeout is five seconds. The SDK cannot interpret partial acceptance; a backend should validate and durably write each batch atomically before 2xx and deduplicate by `(project, eventId)`.

The micro server accepts at most 64 KiB and 100 events per request and validates each event. These are example server limits, not universal contract constants. Apply independent rate limits, schema validation, authorization for reads, retention, and application-specific data removal in your deployment.

The SDK's optional `maxEventsPerMinute` limits new queue admissions per client over a sliding 60-second window (finite values floor/clamp to 1–1,000; omitted/non-finite values disable it). All captured event types share the budget. Excess events are discarded and counted in the existing `dropped` statistic; no aggregate or deferred event is sent. `beforeSend`/`ignoreMessages` filtering and object deduplication do not consume capacity; once full, the SDK skips `beforeSend` for excess events. Flush, retries, beacon delivery, and breadcrumbs do not reset or consume additional capacity. The option changes no wire fields and does not require a collector upgrade. It is local to the client/document and does not replace server-side rate limits or bound HTTP request counts.

`ignoreMessages` optionally omits events whose final sanitized message contains a configured case-sensitive literal substring. It defaults to empty, snapshots a copy at initialization, and skips empty strings/non-string entries. Matching follows `beforeSend` and replacement sanitization, before payload size, value dedupe, and final admission. Matches count once in `filtered`, not `dropped`, and spend no admission or dedupe capacity. The existing early rate-limit gate retains precedence when full. Name/stack/context are not searched; delivery retries do not rematch already queued events. There are no wire fields or collector changes.

`pauseWhileOffline: true` optionally keeps queued events in the existing bounded memory buffer while `navigator.onLine` is exactly `false`, instead of starting new delivery batches or hidden-page beacons. A flush begun offline resolves without draining the queue. Active batches retain their existing retry/timeout behavior; subsequent batches wait. The browser's `online` event resumes delivery when the offline hint clears. This applies to native and custom transports and is snapshotted at initialization, defaulting to false. Missing/unreadable status permits delivery. Connectivity is only a hint, not proof of collector reachability. There is no probe or persistent storage; queue overflow, reload/closure, and destruction can lose pending events. Waiting itself adds no drops, while existing admission, sanitization, diagnostics, IDs, wire format, and collector requirements remain unchanged.

`captureNavigation: true` optionally adds current-window, same-document History navigation to this existing trail. Navigation entries use category `navigation`, message `Navigation`, and scalar `data.from`, `data.to`, and `data.trigger` (`pushState`, `replaceState`, `popstate`, or `hashchange`). URLs use the SDK filters; equivalent filtered URLs are omitted. The server and JSON contract are unchanged. Manual breadcrumbs remain available for app-specific actions.

`captureNetworkBreadcrumbs: true` optionally adds completed fetch/XHR metadata to the same trail. HTTP responses use category `http`, message `HTTP response`, and scalar `data.method`, `data.url`, `data.durationMs`, `data.status`; real transport failures use category `network`, message `Network failure`, and omit status. Native status `0` is retained for opaque responses. Intentional aborts and collector requests are excluded. No body, header, or failure-message data is included. Completion order is preserved; standalone error selection remains controlled by `captureNetwork`/`shouldCaptureHttp`. A custom transport requires an `endpoint` to enable automatic network reporting. Storage and JSON format are unchanged.

`getDiagnostics()` is a local SDK API, not part of `EventBatch` or `ErrorEventRecord`. It exposes queue/sent/drop totals, in-flight event count, separate event-filter and deduplication counts, and `droppedByReason` (`rateLimit`, `queueOverflow`, `payloadTooLarge`, `processingError`, `deliveryError`, `destroyed`). The reason counts sum to the existing dropped total. Reads return independent counter snapshots without invoking hooks or making requests. No server upgrade or diagnostic endpoint is required; `getStats()` remains unchanged. These are SDK-observed decisions and best-effort delivery counts, not collector storage acknowledgements.

`dedupeIntervalMs` optionally omits equivalent sanitized events within a per-client interval (finite floor/clamp 0–60,000 ms; default zero/disabled). It compares final `beforeSend` output, including sorted context and network method/URL/status, while excluding IDs/times/sequence, breadcrumbs, and network duration. The existing early rate-limit gate retains precedence. A suppressed value increments `deduplicated`, not `dropped`, and does not extend the interval or consume admission capacity. At most 50 admitted fingerprints are retained, with lazy expiration and oldest-first eviction; flush/delivery do not reset them and destroy clears them. Existing same-object suppression remains. No duplicate event or occurrence aggregate is sent; wire format and collector requirements are unchanged.

`captureErrorCause: true` optionally appends up to four linked error-like `cause` objects to the existing `stack` string as `Caused by:` sections. Outer name/message and event count remain unchanged. Only string name/message/stack content is used; arbitrary cause payloads and aggregate error arrays are not serialized. Sanitized sections share the 4,096-character stack bound (outer 2,048, each cause section 480). It applies to exception paths and the existing first same-window console Error, while automatic network events retain their existing metadata-only behavior. `beforeSend` can remove the full stack by deleting it or assigning `undefined`. This option adds no protocol fields and requires no collector or viewer upgrade.

`beforeBreadcrumb` optionally filters or edits a valid step before local trail storage. It receives a sanitized copy; `false`/`null` omits it, a replacement or in-place edit is sanitized again, and the SDK preserves its occurrence time. Hook failures omit only the current step and do not change error counters or standalone error selection. It runs on creation only, including automatic navigation/network steps, and is not rerun for error snapshots, `beforeSend` replacements, or retries. The existing breadcrumb wire format and collector requirements are unchanged.

## Resource event compatibility (0.2.0)

`captureResourceErrors: true` enables the new `resource` event type for observable script, stylesheet-link, and image loading failures. The schema remains v1, using existing `context.resourceTag` (`script`, `link`, `img`) and `context.resourceUrl` scalar fields. These events do not include HTTP status, response data, timing, or stack; the element error event does not provide those facts. Existing context limits and SDK filters apply.

**Deploy a 0.2.0-or-later collector/viewer before enabling resource capture.** Custom backends must extend accepted event types and query filters to include `resource`. Older validators can reject a whole mixed batch. The option defaults to false. The included collector, SQLite/JSONL storage, resource type queries, viewer charts/details, and history import/export support this type in 0.2.0 without a database migration. It is counted separately from fetch/XHR HTTP and transport failures.

The SDK additionally attempts its existing bounded beacon on `window.pagehide`, while retaining hidden `visibilitychange` as the primary trigger. The same clean same-origin endpoint, native-transport, offline gate, and accepted-only dequeue rules apply. A cached document is not destroyed by `pagehide`, and `destroy()` removes the listener. The fallback adds no wire fields or collector requirements and remains best effort.

## Read events

The viewer expects list and detail operations, with `/api` as its default base path:

```text
GET /api/events?project=...&environment=...&type=...&query=...&from=...&to=...&cursor=...&limit=30
-> { "events": [...], "nextCursor": "optional-opaque-cursor" }

GET /api/events/:eventId?project=my-web
-> ErrorEventRecord or 404
```

`from` and `to` are ISO UTC instants. Use `(project, eventId)` as identity and stable newest-first ordering for pagination. Scope each read to the caller's permitted projects; CORS alone is not authorization. The viewer's TypeScript `EventDataSource` has `listEvents(filter, signal)` and `getEvent(project, eventId, signal)` methods. For a different same-origin API base, configure the viewer before its entry script:

```html
<script>
  window.__ERROR_LOG_VIEWER_CONFIG__ = {
    apiBase: '/monitoring', mode: 'live', title: 'Browser Error Log'
  };
</script>
```

The viewer fetches up to 100 cursor pages and 10,000 unique events for a selected range, then computes charts in the browser. It marks capped results as partial; these are not full-database aggregates. JSON import/export is local to the browser, accepts at most 10 MiB and 10,000 events, and preserves the `partial` flag. Import does not upload to the server or restore a database. Charts count captured events, not users or errors per request.

## Capture boundaries

Initialization starts capture; earlier events cannot be recovered. Aborted requests are excluded. The SDK does not record request/response bodies, cookies, form values, page HTML, element text, or session replay. URL and message masking is best-effort and needs application-specific review. A custom transport without `endpoint` disables automatic fetch/XHR capture so its own requests cannot feed back into capture. Resource capture is independent and observes current-document HTTP(S) resource URLs only; unsupported elements, other documents, and events that do not reach the window are outside its scope. `beforeSend` and `sanitizeUrl` failures drop events. Source-map resolution, native crashes, alerts, and server-wide aggregates are not implemented. See the [backend contract](server-request.md) for an independent implementation path.
