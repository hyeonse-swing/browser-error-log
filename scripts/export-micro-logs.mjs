import { createReadStream } from 'node:fs';
import { open, readdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { isEventRecord } from '../apps/local-collector/store.ts';

const directory = resolve(process.argv[2] ?? '.data/micro-server');
const destination = resolve(process.argv[3] ?? `micro-events-${Date.now()}.json`);
const names = (await readdir(directory))
  .filter(name => /^events(?:\.[1-9]\d*)?\.jsonl$/.test(name))
  .sort((a, b) => Number(b.match(/\.(\d+)\./)?.[1] ?? 0) - Number(a.match(/\.(\d+)\./)?.[1] ?? 0));
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
  if (totalBytes > 128 * 1024 * 1024) throw new Error('Export input exceeds 128 MiB; use a smaller copy of the logs.');
  if (!size) continue;
  const file = await open(path, 'r');
  const last = Buffer.alloc(1);
  try { await file.read(last, 0, 1, size - 1); } finally { await file.close(); }
  const terminated = last[0] === 10;
  const input = createReadStream(path, { start: 0, end: size - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const accept = (line, allowIncomplete) => {
    // The collector adds receivedAt after the request's 64 KiB bound.
    if (Buffer.byteLength(line) > 128 * 1024) throw new Error(`Oversized event line in ${name}`);
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
    if (records.size > 10000) { records.delete(records.keys().next().value); omitted++; }
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
if (Buffer.byteLength(output) > 10 * 1024 * 1024) throw new Error('JSON exceeds the viewer 10 MiB limit; export a smaller copy of the logs.');
await writeFile(destination, output, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ file: destination, events: records.size, duplicates, omitted, incompleteTails, partial: true }));
