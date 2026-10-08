# v1 integration contract

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
    "sdkVersion": "0.1.0",
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

Optional fields are `name`, `stack`, `componentStack`, `browser`, `context`, and `network`. Context values are strings, finite numbers, booleans, or null. Network data contains `method`, `url`, `durationMs`, and optionally `status`. Event times use ISO UTC; the server may add `receivedAt`. `project` and `Origin` are public client claims, not authentication.

A 2xx response acknowledges the whole batch; the SDK ignores its body. It retries 429, 5xx, and network failures up to twice after the first attempt, with the same event IDs. Other 4xx responses are permanent failures. The default per-attempt timeout is five seconds. The SDK cannot interpret partial acceptance; a backend should validate and durably write each batch atomically before 2xx and deduplicate by `(project, eventId)`.

The micro server accepts at most 64 KiB and 100 events per request and validates each event. These are example server limits, not universal contract constants. Apply independent rate limits, schema validation, authorization for reads, retention, and application-specific data removal in your deployment.

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

Initialization starts capture; earlier events cannot be recovered. Aborted requests are excluded. The SDK does not record request/response bodies, cookies, form values, DOM, or session replay. URL and message masking is best-effort and needs application-specific review. A custom transport without `endpoint` disables automatic network capture so its own requests cannot feed back into capture. `beforeSend` and `sanitizeUrl` failures drop events. Source-map resolution, native crashes, alerts, and server-wide aggregates are not implemented. See the [backend contract](server-request.md) for an independent implementation path.
