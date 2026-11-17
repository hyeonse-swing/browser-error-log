# Collector and protocol integration

Use `@ihyeon/browser-error-log-protocol` directly when building a collector/viewer; it does not require React or the browser SDK. Inspect the installed declarations for `EventBatch`, `ErrorEventRecord`, `EventFilter`, `EventPage`, and `EventDataSource`. Types do not validate untrusted HTTP payloads at runtime.

The SDK sends `POST application/json` with `credentials: 'omit'` to its configured endpoint:

```ts
import { SCHEMA_VERSION, type EventBatch, type ErrorEventRecord } from '@ihyeon/browser-error-log-protocol';

function makeBatch(events: ErrorEventRecord[]): EventBatch {
  return { schemaVersion: SCHEMA_VERSION, events };
}
```

Schema version is 1. Preserve the supplied stable event ID. Server storage/read authorization and validation belong to the backend. Deduplicate by `(project, eventId)`; `project` and browser Origin are public claims, not credentials. The client supplies `occurredAt`; the server owns any `receivedAt` value.

A 2xx response acknowledges the whole batch and the SDK ignores its body. Validate and durably accept the full batch before 2xx if the backend promises durable storage. Partial acceptance is not expressible by the SDK. Network failures, 429 and 5xx are retried up to twice after the first attempt with the same IDs; other 4xx are permanent failures. Replays must not create duplicates.

Optional context contains scalar strings, finite numbers, booleans or null. Optional network metadata and breadcrumbs must survive storage/export if the integration claims to support them. `isBreadcrumbTrail` checks breadcrumb structure/bounds (20 entries, 12,000 UTF-8 JSON bytes); it does not validate the whole event or redact personal information.

For the repository's self-hosted micro server, use its checked-out version's README and `docs/micro-server.md` for actual environment variables, allowed origins, read authentication and SQLite/JSONL operations. That server is not installed by the three npm SDK packages. Keep local demo fixtures distinct from a deployed collector; never place the viewer password in a browser bundle.

Verify the receiving backend with a synthetic SDK batch, repeated-ID ingestion, and reading the same project/ID under the intended authorization. Do not rewrite an existing backend or relax authentication merely to make an example pass.
