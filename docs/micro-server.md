# Self-host the micro server

The micro server is a single-process Node.js 24 example that receives SDK events and writes to a disk you control. SQLite mode serves the included viewer and query API. JSONL mode keeps bounded rotating logs for later offline analysis. The server uses Node built-ins at runtime; no managed database or queue is bundled.

## Storage modes

| Mode | Current behavior | Default limits |
| --- | --- | --- |
| `sqlite` (default) | Durable SQLite file, viewer, list and detail APIs | Seven days from receipt, 10,000 events, 64 MiB main DB file |
| `jsonl` | One event per line in rotating files; no online queries or viewer | 8 MiB per file, three files including current |

Both modes need a persistent data directory to survive restarts. SQLite's 64 MiB limit applies to the main database file; rollback journal, OS files, backups, and proxy logs require additional disk. JSONL rotation discards the oldest files. Retries can leave duplicate lines in JSONL; export deduplicates by `(project, eventId)`.

## Run locally

From the repository root:

```sh
npm ci
npm run micro
```

Open `http://127.0.0.1:4319/` for the viewer and `/install.html` for a send-event example. The ingest endpoint is `http://127.0.0.1:4319/api/events`; SQLite is stored at `.data/micro-server/events.sqlite`. Send the example event and refresh the `my-web` project. On later runs, use `npm run start:micro`. Node 24 may print an experimental warning for its built-in SQLite API.

The default listener is `127.0.0.1` and is available only on your machine. For another local app at `http://localhost:5173`, set its project and exact browser origin:

```sh
MICRO_PROJECTS=my-web \
MICRO_ALLOWED_ORIGINS=http://localhost:5173 \
npm run start:micro
```

Then follow the [SDK installation guide](personal-sdk.md) and set `endpoint: 'http://127.0.0.1:4319/api/events'`. Origin comparison includes scheme, host, and port; `localhost` differs from `127.0.0.1`. Multiple project IDs and origins can be comma-separated. Project IDs use 1 to 64 ASCII letters, digits, `.`, `_`, or `-`, starting with a letter or digit. Origin and project are not authentication credentials.

## JSONL and offline export

Build once with `npm run build:micro`, then run:

```sh
MICRO_STORAGE=jsonl MICRO_DATA_DIR=.data/micro-logs npm run start:micro
```

The ingest endpoint and `/install.html` still work. `/` displays a log-mode notice; list and detail APIs return `501`. Current records are in `events.jsonl`, followed by `events.1.jsonl` and `events.2.jsonl`. SQLite's day-based retention does not apply. Stop the collector to take a consistent file snapshot, then export:

```sh
npm run export:logs -- .data/micro-logs .data/exported-events.json
npm run dev
```

In the local viewer, import `.data/exported-events.json` using its JSON import control. Export is bounded to the newest 10,000 events and 10 MiB; input is capped at 128 MiB. It will not overwrite an existing destination. It marks `partial: true` because older rotated records may already be gone. A truncated final line is reported and skipped; a corrupt line in the middle is an error. JSON import stays in the browser and does not write events back to the server.

## Expose the server

`npm run build:micro` creates `dist/micro-server/`, a standalone Node.js 24 runtime folder. Copy the whole folder to a host and run `node server.mjs` there. Put `MICRO_DATA_DIR` on a persistent disk outside the build directory. This is a single-process, single-disk design; do not point multiple replicas at the same data path.

The [Compose example](../examples/micro-server/compose.yaml) uses Caddy for HTTPS and a named data volume. Configure DNS for your own domain and supply exact project and origin lists. For example, on a host with Docker Compose:

```sh
export MICRO_DOMAIN=errors.example.com
export MICRO_ALLOWED_ORIGINS=https://my-site.example.com
export MICRO_PROJECTS=my-web
read -r -s MICRO_VIEWER_PASSWORD
export MICRO_VIEWER_PASSWORD
docker compose -f examples/micro-server/compose.yaml up -d --build
```

The viewer's Basic-auth username is `viewer`. Set a password of at least 16 characters and manage it as a host secret; do not put it in SDK options or shared command output. Binding to `0.0.0.0` or declaring `MICRO_PUBLIC_URL` requires an HTTPS public origin, that password, explicit projects, and explicit allowed origins. A reverse proxy to a loopback listener is also public and needs the same controls. Ingest does not have a browser secret, so project and Origin checks do not prevent all forged public events. Restrict read access and review your exposure, retention, backup, and restore policies. External TLS and host load have not been validated by the local checks.

Infrastructure is not included. Hosting, servers, databases, storage, bandwidth, domains, backups, and third-party services are selected and paid for by each operator. Any charges are billed independently by their providers, not by this project or its maintainers. A host with ephemeral disk cannot preserve SQLite or JSONL files across replacement. No vendor price or free-tier promise is part of this guide.

## Limits and checks

| Variable | Default | Meaning |
| --- | --- | --- |
| `MICRO_STORAGE` | `sqlite` | Switch to `jsonl` for log-only mode |
| `MICRO_DATA_DIR` | `.data/micro-server` | Persistent data directory |
| `MICRO_PORT` | `4319` | Server port |
| `MICRO_RETENTION_DAYS` | `7` | SQLite receipt-time retention |
| `MICRO_MAX_EVENTS` | `10000` | SQLite event count cap |
| `MICRO_MAX_DB_MB` | `64` | SQLite main-file MiB cap |
| `MICRO_LOG_FILE_MB` | `8` | JSONL MiB per file |
| `MICRO_LOG_FILES` | `3` | JSONL files including current |
| `MICRO_REQUESTS_PER_MINUTE` | `120` | Process-wide request limit |

Ingest accepts at most 64 KiB and 100 events per request. In SQLite mode, a batch also cannot exceed `MICRO_MAX_EVENTS`. Excess request size or batch capacity returns `413`, rate limits return `429`, and storage failure returns `503`. The SDK's bounded retries can still end in data loss. `npm run check:micro` builds and tests SQLite persistence, read authentication, JSONL logging, and export. Test HTTPS, backups, restore, and operational load in the actual deployment.
