# Self-owned backend contract

English | [한국어](ko/server-request.md)

The included [micro server](micro-server.md) is the shortest path to persistent local records. Use this document when you need an independent backend, a different database, or existing service authorization. It describes implementation responsibilities against the current [v1 SDK and viewer contract](integration.md); it is not a claim that a production backend has been deployed.

## Required for the current viewer

Accept `POST /api/events` with the v1 `EventBatch` type from `packages/protocol`. Reject invalid batches before storage; impose request, event-count, and rate limits. Treat the client-provided project, Origin, and timestamps as untrusted. Store by `(project, eventId)` so retrying a batch does not create duplicate records. Return 2xx only when the entire batch has been durably accepted or deduplicated. A 429 or 5xx can be retried by the SDK; other 4xx failures are final. If partial success is unavoidable, persist idempotently because the SDK retries at batch granularity.

Serve the current viewer operations:

```text
GET /api/events?project=...&environment=...&type=...&query=...&from=...&to=...&cursor=...&limit=30
GET /api/events/:eventId?project=...
```

Return `{ "events": [...], "nextCursor": "opaque-cursor-if-more" }` for lists and an event or 404 for detail. Order newest first with a stable tie-breaker and keep cursor boundaries stable as new events arrive. Scope reads to the caller's authorized projects. `EventDataSource` in `packages/protocol` is the viewer-side interface. A same-origin API can be selected through `window.__ERROR_LOG_VIEWER_CONFIG__` as shown in the [integration contract](integration.md). A cross-origin viewer needs an explicit CORS and authentication design.

## Operator responsibilities

- Set a retention and deletion policy, disk or database capacity limits, backups, and restore checks. The example's seven-day/10,000-event limits are not universal service requirements.
- Protect all viewer and query access. Browser `project` and `Origin` checks are not proof of identity. Avoid putting long-lived server secrets in browser code.
- Validate or remove application-specific identifiers in URL paths, messages, stack traces, and `context`, even when the SDK's `sanitizeUrl` and `beforeSend` hooks are configured. No automatic redaction is complete.
- Keep collection from disrupting the application: bound batch size and rate, handle storage errors, and expect loss during offline use, tab close, and exhausted retries. Test a controlled event through ingest, persistence, list, detail, deletion, and restore.
- Distinguish event occurrence time from server receipt time. Use receipt time for storage retention if client clocks may be wrong.

For a small single-host deployment, the included SQLite implementation already covers a bounded version of this contract. JSONL only supports ingest and offline export; its list and detail APIs return `501`. The local development collectors use memory and lose records on restart. Do not infer persistent behavior from a memory demo.

## Later extensions

The current viewer fetches up to 100 pages and 10,000 unique events and computes charts locally. At that cap, it marks the result partial. If an operator needs complete counts across more stored events, design a server aggregate API and adapt the viewer together, with the same filters, authorization, and retention boundary as event reads. Source-map upload and symbolication, grouping events into issues, alerts, and operator workflows are roadmap items, not current APIs. See the [roadmap](expansion-roadmap.md).

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.
