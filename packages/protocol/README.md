# @browser-error-log/protocol

Versioned TypeScript contracts for Browser Error Log SDKs, collectors, and viewers. Use them when connecting the SDK to your own backend or implementing a viewer data source.

**Release status:** unpublished source preview, with `private: true` and license selection pending. In the source checkout, `npm run check:package` generates `output/packages/browser-error-log-protocol-0.1.0.tgz`; install that file by absolute path. Registry installation is only planned for a future release.

## Event and query contracts

```ts
import {
  SCHEMA_VERSION,
  EVENT_LABELS,
  type ErrorEventRecord,
  type EventBatch,
  type EventFilter,
  type EventPage,
  type EventDataSource,
} from '@browser-error-log/protocol';

function makeBatch(events: ErrorEventRecord[]): EventBatch {
  return { schemaVersion: SCHEMA_VERSION, events };
}
```

- `ErrorEventRecord` describes a v1 event, including project, environment, release, event ID, occurrence time, type, message, page, runtime, and optional stack, network, and custom context fields.
- `EventBatch` wraps events as `{ schemaVersion: 1, events: [...] }` for ingestion.
- `EventFilter` supports project, environment, type, text query, time range, cursor, and limit.
- `EventPage` returns `events` and an optional `nextCursor`.
- `EventDataSource` exposes `listEvents(filter, signal?)` and `getEvent(project, eventId, signal?)` for the viewer.
- `EVENT_LABELS` provides English display labels. The underlying event type identifiers stay unchanged.

These are types and constants, not a runtime validator, database, or HTTP server. Treat all incoming data as untrusted and validate it at your collector. Scope deduplication and event lookup by `(project, eventId)`; different projects may use the same event ID. Use ISO timestamps and distinguish client-supplied `occurredAt` from server-owned `receivedAt`.

The repository's `docs/integration.md` describes the HTTP contract; `examples/micro-server` implements a small self-hosted collector with persistent SQLite or log-only JSONL storage. The in-memory development collector is only a demo.

## Hosting and costs

The package provides no managed infrastructure. Each operator is responsible for selecting and paying their server, database, storage, network, and other providers. Provider charges are independent of this project and its maintainers.
