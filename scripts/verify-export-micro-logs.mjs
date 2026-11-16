import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseHistoryJson } from '../apps/viewer/src/history.ts';

const exporter = resolve('dist/micro-server/export.mjs');
const folders = [];
const event = (eventId, patch = {}) => ({
  schemaVersion: 1, eventId, project: 'web', environment: 'test', release: 'r1', sdkVersion: '0.1.0',
  occurredAt: '2026-10-02T00:00:00.000Z', viewId: 'view', sequence: 1, elapsedMs: 1,
  type: 'manual', message: 'Synthetic event', page: '/home', runtime: 'browser', ...patch,
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function folder() {
  const path = await mkdtemp(join(tmpdir(), 'micro-export-'));
  folders.push(path);
  return path;
}
function database(directory) {
  const db = new DatabaseSync(join(directory, 'events.sqlite'));
  db.exec(`CREATE TABLE events (
    project TEXT NOT NULL COLLATE BINARY, event_id TEXT NOT NULL COLLATE BINARY,
    occurred_at TEXT NOT NULL COLLATE BINARY, received_at TEXT NOT NULL COLLATE BINARY,
    environment TEXT NOT NULL COLLATE BINARY, type TEXT NOT NULL COLLATE BINARY,
    search_text TEXT NOT NULL COLLATE BINARY, payload TEXT NOT NULL,
    PRIMARY KEY (project, event_id)
  )`);
  return db;
}
function insert(db, item, payload = JSON.stringify(item)) {
  db.prepare(`INSERT INTO events
    (project, event_id, occurred_at, received_at, environment, type, search_text, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(item.project, item.eventId, item.occurredAt,
    '2026-10-02T00:01:00.000Z', item.environment, item.type, item.message, payload);
}
function run(directory, destination, ...args) {
  return spawnSync(process.execPath, [exporter, directory, destination, ...args], { encoding: 'utf8', timeout: 30_000 });
}
function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function failure(result, pattern) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, pattern);
}

test.after(async () => {
  await Promise.all(folders.map(path => rm(path, { recursive: true, force: true })));
});

test('SQLite auto export is read-only, ordered, bounded, and accepted by the viewer importer', async () => {
  const directory = await folder();
  const db = database(directory);
  const trail = [{ occurredAt: '2026-10-02T00:00:00.000Z', category: 'navigation', message: 'Opened', data: { route: '/home' } }];
  const resource = event('same', { project: 'z-project', type: 'resource', name: 'ResourceLoadError',
    context: { resourceTag: 'link' }, breadcrumbs: trail });
  const same = event('same', { project: 'a-project' });
  const newer = event('newer', { occurredAt: '2026-10-03T00:00:00.000Z' });
  for (const item of [same, resource, newer]) insert(db, item);
  db.close();
  const source = join(directory, 'events.sqlite');
  const before = digest(await readFile(source));
  const destination = join(directory, 'export.json');
  const summary = success(run(directory, destination));
  assert.deepEqual([summary.events, summary.omitted, summary.partial], [3, 0, true]);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  const output = await readFile(destination, 'utf8');
  assert.deepEqual(JSON.parse(output).events.map(item => [item.project, item.eventId]),
    [['web', 'newer'], ['z-project', 'same'], ['a-project', 'same']]);
  const imported = parseHistoryJson(output);
  assert.equal(imported.truncated, true);
  assert.equal(imported.events.length, 3);
  assert.deepEqual(imported.events.find(item => item.project === 'z-project').breadcrumbs, trail);
  assert.equal(imported.events.find(item => item.project === 'z-project').type, 'resource');
  assert.equal(digest(await readFile(source)), before);
});

test('legacy JSONL order and duplicate handling survive auto and explicit mode; mixed stores require a choice', async () => {
  const directory = await folder();
  const old = event('old');
  const newer = event('new', { occurredAt: '2026-10-03T00:00:00.000Z' });
  await writeFile(join(directory, 'events.1.jsonl'), `${JSON.stringify(old)}\n`);
  await writeFile(join(directory, 'events.jsonl'), `${JSON.stringify({ ...old, message: 'retry' })}\n${JSON.stringify(newer)}\n`);
  const automatic = join(directory, 'auto.json');
  const explicit = join(directory, 'explicit.json');
  const autoSummary = success(run(directory, automatic));
  const explicitSummary = success(run(directory, explicit, '--storage=jsonl'));
  assert.deepEqual([autoSummary.events, autoSummary.duplicates, autoSummary.omitted, autoSummary.incompleteTails], [2, 1, 0, 0]);
  assert.deepEqual([explicitSummary.events, explicitSummary.duplicates], [2, 1]);
  assert.equal(await readFile(automatic, 'utf8'), await readFile(explicit, 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(automatic, 'utf8')).events.map(item => item.message), ['Synthetic event', 'Synthetic event']);
  const db = database(directory);
  insert(db, event('sqlite-only'));
  db.close();
  const ambiguous = join(directory, 'ambiguous.json');
  failure(run(directory, ambiguous), /Both SQLite and JSONL stores exist/);
  await assert.rejects(stat(ambiguous), { code: 'ENOENT' });
  const selected = join(directory, 'sqlite.json');
  assert.equal(success(run(directory, selected, '--storage', 'sqlite')).events, 1);
});

test('empty, missing, symlinked and corrupt databases fail safely or export an empty partial envelope', async () => {
  const directory = await folder();
  const missing = join(directory, 'missing.json');
  failure(run(directory, missing), /No events.sqlite or events.jsonl store found/);
  failure(run(directory, missing, '--storage=sqlite'), /No events.sqlite file found/);
  await assert.rejects(stat(join(directory, 'events.sqlite')), { code: 'ENOENT' });
  const db = database(directory);
  db.close();
  const empty = join(directory, 'empty.json');
  assert.equal(success(run(directory, empty)).events, 0);
  assert.deepEqual(JSON.parse(await readFile(empty, 'utf8')), { schemaVersion: 1, partial: true, events: [] });
  await rm(join(directory, 'events.sqlite'));
  await writeFile(join(directory, 'real.db'), 'not a database');
  await symlink(join(directory, 'real.db'), join(directory, 'events.sqlite'));
  failure(run(directory, missing, '--storage=sqlite'), /regular file, not a symbolic link/);
  await rm(join(directory, 'events.sqlite'));
  await writeFile(join(directory, 'events.sqlite'), 'not a database');
  failure(run(directory, missing, '--storage=sqlite'), /database disk image is malformed|file is not a database/);
  await assert.rejects(stat(missing), { code: 'ENOENT' });
});

test('invalid modes, malformed rows, oversized rows, and an existing destination never produce replacement output', async () => {
  const directory = await folder();
  const db = database(directory);
  const item = event('one');
  insert(db, item);
  db.close();
  const destination = join(directory, 'export.json');
  failure(run(directory, destination, '--storage=other'), /--storage must be sqlite or jsonl/);
  failure(run(directory, destination, '--storage=sqlite', '--storage=jsonl'), /Usage:/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  await writeFile(destination, 'keep');
  failure(run(directory, destination), /EEXIST/);
  assert.equal(await readFile(destination, 'utf8'), 'keep');
  const changed = new DatabaseSync(join(directory, 'events.sqlite'));
  const update = changed.prepare('UPDATE events SET payload = ? WHERE project = ? AND event_id = ?');
  for (const [payload, expected] of [
    ['{', /Invalid JSON payload/],
    [JSON.stringify({ ...item, type: 'unknown' }), /Invalid v1 event/],
    [JSON.stringify({ ...item, eventId: 'forged' }), /Invalid v1 event/],
    [JSON.stringify({ ...item, context: { large: 'x'.repeat(129 * 1024) } }), /Invalid or oversized SQLite event row/],
  ]) {
    update.run(payload, item.project, item.eventId);
    failure(run(directory, join(directory, 'never.json'), '--storage=sqlite'), expected);
    await assert.rejects(stat(join(directory, 'never.json')), { code: 'ENOENT' });
  }
  changed.close();
});

test('SQLite export keeps the newest 10,000 rows and rejects output beyond 10 MiB before writing', async () => {
  const directory = await folder();
  const db = database(directory);
  const add = db.prepare(`INSERT INTO events
    (project, event_id, occurred_at, received_at, environment, type, search_text, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  for (let index = 0; index <= 10_000; index++) {
    const item = event(`id-${String(index).padStart(5, '0')}`, { occurredAt: new Date(Date.parse('2026-10-02T00:00:00Z') + index).toISOString() });
    add.run(item.project, item.eventId, item.occurredAt, '2026-10-02T00:01:00Z', item.environment, item.type, item.message, JSON.stringify(item));
  }
  db.exec('COMMIT');
  db.close();
  const destination = join(directory, 'capped.json');
  const summary = success(run(directory, destination, '--storage=sqlite'));
  assert.deepEqual([summary.events, summary.omitted], [10_000, 1]);
  const events = JSON.parse(await readFile(destination, 'utf8')).events;
  assert.deepEqual([events[0].eventId, events.at(-1).eventId], ['id-10000', 'id-00001']);

  const largeDirectory = await folder();
  const largeDb = database(largeDirectory);
  largeDb.exec('BEGIN');
  for (let index = 0; index < 170; index++) {
    insert(largeDb, event(`large-${index}`, { context: { detail: 'x'.repeat(64 * 1024) } }));
  }
  largeDb.exec('COMMIT');
  largeDb.close();
  const tooLarge = join(largeDirectory, 'too-large.json');
  failure(run(largeDirectory, tooLarge, '--storage=sqlite'), /viewer 10 MiB limit/);
  await assert.rejects(stat(tooLarge), { code: 'ENOENT' });
});
