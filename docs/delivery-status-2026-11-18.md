# Per-event delivery status — 2026-11-18

The 0.2.14 SDK returns an admitted event ID from `captureException()`, but `getStats()` only gives aggregate counts. After a queue eviction or delivery failure, a caller holding an ID cannot tell what happened to that event. `sent` also includes successful `sendBeacon()` queue admission, which is distinct from an HTTP response.

Add an optional, in-memory lookup for recent IDs on the capture client. `deliveryStatusLimit` defaults to zero, so existing clients do not allocate a history map or snapshot IDs for it. A positive value retains at most 100 IDs per client and evicts the oldest admitted ID when full. The status lookup returns `unknown` for disabled tracking, an ID never admitted to that client, or a history entry evicted by the limit. It stores only IDs, state, and a drop reason, never event payloads. It is scoped to one client and disappears when the client is garbage-collected.

The states distinguish queued, in-flight (including retries), transport-accepted (HTTP 2xx or successful custom transport), browser beacon-queued, and dropped with the existing drop reason. Neither successful transport nor beacon acceptance proves collector persistence. The existing collector's `(project, eventId)` lookup remains the confirmation step. The old `BrowserErrorLogClient` and diagnostics interfaces stay structurally compatible; the lookup is on the capture-client return type of `init()`.

The implementation must snapshot IDs before invoking a user transport, because that callback can mutate its batch or reenter the SDK. It must account for queue overflow, destruction during an in-flight send, failed delivery, and accepted beacons. Verification covers these transitions, disabled and bounded tracking, and packaged TypeScript/ESM/CJS consumers.

## Local verification

- `npm run check` passed TypeScript, 388 tests, and build. The browser SDK ESM gzip output was 9,388 bytes against the 20,480-byte budget.
- `npm run check:package` passed offline tarball installation, exported declarations, ESM/CJS, SSR, and bundled AI guide integrity checks.
- `npm run check:micro` passed five export tests and the built collector smoke. `npm run check:browser` passed 54 Chromium/WebKit tests after the opt-out allocation adjustment.
- `node --test scripts/release.test.mjs` passed 18 release-path tests. The full test run includes seven new per-event status cases.

These checks use synthetic data and local browsers. Collector persistence remains a separate lookup, and no application-wide runtime CPU or memory reduction is claimed from the opt-out implementation.
