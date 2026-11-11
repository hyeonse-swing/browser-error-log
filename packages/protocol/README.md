# @ihyeon/browser-error-log-protocol

English | [한국어](https://github.com/hyeonse-swing/browser-error-log/blob/main/packages/protocol/README.ko.md)

Versioned TypeScript contracts for Browser Error Log SDKs, collectors, and viewers. Use them when connecting the SDK to your own backend or implementing a viewer data source.

Install directly when implementing your own collector or viewer; `@ihyeon/browser-error-log` also brings this package in as a dependency:

```sh
npm install @ihyeon/browser-error-log-protocol
```

For local source-checkout development, use Node.js 24, `npm ci`, and `npm run check:package`, then install `output/packages/ihyeon-browser-error-log-protocol-0.2.6.tgz` by absolute path. See the [SDK guide](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/personal-sdk.md).

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
} from '@ihyeon/browser-error-log-protocol';

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

`Breadcrumb` describes optional `ErrorEventRecord.breadcrumbs`. `BREADCRUMB_LIMITS` and `isBreadcrumbTrail(value)` provide shared bounds and validation: at most 20 entries and 12,000 UTF-8 JSON bytes, canonical UTC `occurredAt` (`Date.toISOString()`), nonempty category/message (40/256 characters), and optional scalar `data` (six keys, key length 80, string length 200). Unknown breadcrumb properties, nested data, and non-finite numbers are rejected. Empty arrays are valid. Validation does not redact content; SDK filters or application-specific server controls handle removal.

The package does not validate complete events or provide a database or HTTP server. Validate incoming events at your collector. Deduplicate and look up by `(project, eventId)`; distinguish client-supplied `occurredAt` from server-owned `receivedAt`.

The [integration contract](https://github.com/hyeonse-swing/browser-error-log/blob/main/docs/integration.md) describes the HTTP API; `examples/micro-server` implements a small self-hosted collector with persistent SQLite or log-only JSONL storage. The in-memory development collector is only a demo.

## Hosting and costs

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.
