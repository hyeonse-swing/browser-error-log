import { createReadStream } from 'node:fs';
import { open, readdir, lstat, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { isEventRecord } from '../apps/local-collector/store.ts';

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_ROW_BYTES = 128 * 1024;
const MAX_EVENTS = 10_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const prefix = '{"schemaVersion":1,"partial":true,"events":[';
const suffix = ']}';

const { values, positionals, tokens } = parseArgs({
  args: process.argv.slice(2), allowPositionals: true, strict: true, tokens: true,
  options: { storage: { type: 'string' } },
});
if (positionals.length > 2 || tokens.filter(token => token.kind === 'option' && token.name === 'storage').length > 1) {
  throw new Error('Usage: export.mjs [data-directory] [destination] [--storage sqlite|jsonl]');
}
if (values.storage !== undefined && values.storage !== 'sqlite' && values.storage !== 'jsonl') {
  throw new Error('--storage must be sqlite or jsonl.');
}
const directory = resolve(positionals[0] ?? '.data/micro-server');
const destination = resolve(positionals[1] ?? `micro-events-${Date.now()}.json`);
const names = (await readdir(directory))
  .filter(name => /^events(?:\.[1-9]\d*)?\.jsonl$/.test(name))
  .sort((a, b) => Number(b.match(/\.(\d+)\./)?.[1] ?? 0) - Number(a.match(/\.(\d+)\./)?.[1] ?? 0));
const sqlitePath = join(directory, 'events.sqlite');
let sqliteInfo;
try { sqliteInfo = await lstat(sqlitePath); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const mode = values.storage ?? (sqliteInfo && names.length ? undefined : sqliteInfo ? 'sqlite' : names.length ? 'jsonl' : undefined);
if (!mode) throw new Error(sqliteInfo && names.length
  ? 'Both SQLite and JSONL stores exist. Select one with --storage sqlite or --storage jsonl.'
  : 'No events.sqlite or events.jsonl store found.');

async function exportJsonl() {
  if (!names.length) throw new Error('No events.jsonl files found. Run the jsonl collector first.');
  if (names.length > 100) throw new Error('Export at most 100 log files at a time.');
  const records = new Map();
  let totalBytes = 0;
  let duplicates = 0;
  let omitted = 0;
  let incompleteTails = 0;

  for (const name of names) {
    const path = resolve(directory, name);
    const size = (await stat(path)).size;
    totalBytes += size;
    if (totalBytes > MAX_INPUT_BYTES) throw new Error('Export input exceeds 128 MiB; use a smaller copy of the logs.');
    if (!size) continue;
    const file = await open(path, 'r');
    const last = Buffer.alloc(1);
    try { await file.read(last, 0, 1, size - 1); } finally { await file.close(); }
    const terminated = last[0] === 10;
    const input = createReadStream(path, { start: 0, end: size - 1 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const accept = (line, allowIncomplete) => {
      // The collector adds receivedAt after the request's 64 KiB bound.
      if (Buffer.byteLength(line) > MAX_ROW_BYTES) throw new Error(`Oversized event line in ${name}`);
      let event;
      try { event = JSON.parse(line); }
      catch {
        if (allowIncomplete) { incompleteTails++; return; }
        throw new Error(`Invalid JSON line in ${name}`);
      }
      if (!isEventRecord(event)) throw new Error(`Invalid v1 event in ${name}`);
      const key = JSON.stringify([event.project, event.eventId]);
      if (records.has(key)) { duplicates++; return; }
      records.set(key, event);
      if (records.size > MAX_EVENTS) { records.delete(records.keys().next().value); omitted++; }
    };
    let previous;
    try {
      for await (const line of lines) {
        if (previous !== undefined) accept(previous, false);
        previous = line;
      }
      if (previous !== undefined) accept(previous, !terminated);
    } finally { lines.close(); input.destroy(); }
  }
  // Rotation may already have removed older records; never claim complete history.
  const output = JSON.stringify({ schemaVersion: 1, partial: true, events: [...records.values()] });
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error('JSON exceeds the viewer 10 MiB limit; export a smaller copy of the logs.');
  return { output, events: records.size, duplicates, omitted, incompleteTails };
}

async function exportSqlite() {
  if (!sqliteInfo) throw new Error('No events.sqlite file found. Run the sqlite collector first.');
  if (!sqliteInfo.isFile() || sqliteInfo.isSymbolicLink()) throw new Error('events.sqlite must be a regular file, not a symbolic link.');
  if (sqliteInfo.size > MAX_INPUT_BYTES) throw new Error('SQLite input exceeds 128 MiB; use a smaller copy of the database.');
  // createStorage() prunes records and may create a missing database; export must do neither.
  const db = new DatabaseSync(sqlitePath, { readOnly: true, readBigInts: true, timeout: 1000 });
  try {
    db.exec('BEGIN');
    const countValue = db.prepare('SELECT COUNT(*) AS count FROM events').get()?.count;
    if (typeof countValue !== 'bigint' || countValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid SQLite event count.');
    const count = Number(countValue);
    const metadata = db.prepare(`SELECT rowid AS row_id,
      length(CAST(payload AS BLOB)) AS payload_bytes,
      length(CAST(occurred_at AS BLOB)) AS occurred_bytes,
      length(CAST(event_id AS BLOB)) AS event_id_bytes,
      length(CAST(project AS BLOB)) AS project_bytes
      FROM events ORDER BY occurred_at DESC, event_id DESC, project DESC LIMIT ?`);
    const payloadByRow = db.prepare('SELECT payload, occurred_at, event_id, project FROM events WHERE rowid = ?');
    const encoded = [];
    let bytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
    for (const row of metadata.iterate(MAX_EVENTS)) {
      if (typeof row.row_id !== 'bigint' || typeof row.payload_bytes !== 'bigint'
        || row.payload_bytes > BigInt(MAX_ROW_BYTES) || row.payload_bytes < 1n
        || typeof row.occurred_bytes !== 'bigint' || row.occurred_bytes > 8192n
        || typeof row.event_id_bytes !== 'bigint' || row.event_id_bytes > 8192n
        || typeof row.project_bytes !== 'bigint' || row.project_bytes > 8192n) {
        throw new Error('Invalid or oversized SQLite event row.');
      }
      const stored = payloadByRow.get(row.row_id);
      if (!stored || typeof stored.payload !== 'string' || typeof stored.occurred_at !== 'string'
        || typeof stored.event_id !== 'string' || typeof stored.project !== 'string') {
        throw new Error('Invalid SQLite event row.');
      }
      let event;
      try { event = JSON.parse(stored.payload); }
      catch { throw new Error('Invalid JSON payload in SQLite event row.'); }
      if (!isEventRecord(event) || event.occurredAt !== stored.occurred_at
        || event.eventId !== stored.event_id || event.project !== stored.project) {
        throw new Error('Invalid v1 event in SQLite event row.');
      }
      const serialized = JSON.stringify(event);
      bytes += Buffer.byteLength(serialized) + (encoded.length ? 1 : 0);
      if (bytes > MAX_OUTPUT_BYTES) throw new Error('JSON exceeds the viewer 10 MiB limit; export a smaller copy of the database.');
      encoded.push(serialized);
    }
    return { output: `${prefix}${encoded.join(',')}${suffix}`, events: encoded.length,
      duplicates: 0, omitted: count - encoded.length, incompleteTails: 0 };
  } finally {
    try { if (db.isTransaction) db.exec('ROLLBACK'); }
    finally { db.close(); }
  }
}

const result = mode === 'sqlite' ? await exportSqlite() : await exportJsonl();
await writeFile(destination, result.output, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ file: destination, events: result.events, duplicates: result.duplicates,
  omitted: result.omitted, incompleteTails: result.incompleteTails, partial: true }));
