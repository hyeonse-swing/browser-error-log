# Project roadmap

English | [한국어](ko/expansion-roadmap.md)

This roadmap describes possible public-project improvements. It does not announce a deployment, release date, vendor choice, or committed feature. The current behavior is documented in the [README](../README.md), [SDK guide](personal-sdk.md), [micro server guide](micro-server.md), and [v1 contract](integration.md).

## Current baseline

The browser SDK captures global JavaScript exceptions, unhandled promises, fetch/XHR failures, selected HTTP responses, and manual errors. It has bounded buffering, per-attempt timeouts, and limited retries. The optional React adapter catches render errors. The viewer offers filters, timeline/detail, charts over fetched records, and local JSON import/export. A single-process micro server persists SQLite records or rotating JSONL logs. Development demo collectors use memory only.

The MIT-licensed `0.1.0` browser SDK, React adapter, and protocol packages are published on npm. The `0.1.1` i18n update is pending publication. The source remains available in the GitHub repository; an npm publication is separate from a GitHub release or tag. See the [release guide](releasing.md) for verification and future-release steps.

The SQLite defaults are seven days from receipt, 10,000 events, and a 64 MiB main database file. JSONL defaults to three 8 MiB files and has no online query API. The viewer limits fetched analysis to 100 pages and 10,000 unique events; capped results are explicitly partial. These limits make the starter deployment understandable, but they are not a guarantee of complete capture or suitability for every workload.

## Next decisions and possible work

| Area | Candidate work | Reason to consider it |
| --- | --- | --- |
| SDK reliability | Bound repeated identical errors, distinguish drop causes, test supported browser and WebView versions | Make high-volume failure behavior easier to understand |
| Privacy controls | Document tested application-specific filters and a server-side removal point | Reduce accidental collection of identifiers in paths, messages, stacks, or context |
| Diagnostics | Add private source-map handling and careful event grouping | Connect deployed stacks to source and group repeat failures without hiding distinct causes |
| Larger datasets | Define server aggregation with the same filters and access rules as event queries | Show complete counts when viewer fetch limits are reached |
| Operations | Restore exercises, backups, access review, optional alerts and issue workflow | Support operators who need longer retention or response processes |

Each extension needs an implementation, documentation, and checks against the actual deployment. An operator can use the current SQLite server without waiting for these additions. A custom backend can implement the [self-owned contract](server-request.md) with its own storage and access design.

Current exclusions include session replay, native app crashes, guaranteed or exactly-once browser delivery, automated source maps, alerts, and server-wide aggregates. Default URL masking is best-effort and does not replace application-specific privacy review. Charts count captured events, not users or error rates against all requests.

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers.
