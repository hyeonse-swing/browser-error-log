import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ErrorEventRecord, EventFilter, EventPage } from 'browser-error-log-protocol';
import { isEventRecord } from '../../../apps/local-collector/store.ts';
import type { MicroStorage, StorageMode, StorageOptions, WriteResult } from './types.ts';

const DAY_MS = 86_400_000;
const DEFAULT_PAGE_SIZE = 4096;
const CURSOR_MAX_LENGTH = 32_768;

function normalizeEvents(events: ErrorEventRecord[], receivedAt: string): ErrorEventRecord[] {
  if (!Array.isArray(events) || events.some(event => !isEventRecord(event))) {
    throw new Error('Invalid event record');
  }
  // Build every payload before a transaction or append. Extra request properties are not persisted.
  return events.map(event => {
    if (event.context && Object.values(event.context).some(value => typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('Invalid event record');
    }
    return {
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      project: event.project,
      environment: event.environment,
      release: event.release,
      sdkVersion: event.sdkVersion,
      occurredAt: new Date(event.occurredAt).toISOString(),
      receivedAt,
      viewId: event.viewId,
      sequence: event.sequence,
      elapsedMs: event.elapsedMs,
      type: event.type,
      message: event.message,
      ...(event.name !== undefined ? { name: event.name } : {}),
      ...(event.stack !== undefined ? { stack: event.stack } : {}),
      ...(event.componentStack !== undefined ? { componentStack: event.componentStack } : {}),
      page: event.page,
      runtime: event.runtime,
      ...(event.browser !== undefined ? { browser: event.browser } : {}),
      ...(event.context !== undefined ? { context: { ...event.context } } : {}),
      ...(event.network !== undefined ? { network: {
        method: event.network.method,
        url: event.network.url,
        durationMs: event.network.durationMs,
        ...(event.network.status !== undefined ? { status: event.network.status } : {}),
      } } : {}),
    };
  });
}

function timestamp(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value)) throw new Error('Invalid server time');
  return new Date(value).toISOString();
}

function dateBoundary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Invalid date filter');
  return new Date(parsed).toISOString();
}

type Cursor = [string, string, string];
function parseCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    if (value.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const tuple: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(tuple) || tuple.length !== 3 || tuple.some(part => typeof part !== 'string')) throw new Error();
    const [at, id, project] = tuple as Cursor;
    if (at !== dateBoundary(at) || !id || !project || id.length > 8192 || project.length > 8192) throw new Error();
    if (Buffer.from(JSON.stringify(tuple)).toString('base64url') !== value) throw new Error();
    return [at, id, project];
  } catch {
    throw new Error('Invalid cursor');
  }
}

function pageLimit(value: number | undefined): number {
  const number = Number(value);
  return Math.min(100, Math.max(1, Number.isFinite(number) && number !== 0 ? Math.trunc(number) : 50));
}

type Row = { payload: string; occurred_at: string; event_id: string; project: string };

class SqliteStorage implements MicroStorage {
  readonly mode = 'sqlite' as const;
  readonly queryable = true;
  private closed = false;
  private readonly insert;
  private readonly deleteExpired;
  private readonly deleteBeyondCap;
  private readonly selectOne;

  constructor(private readonly db: DatabaseSync, private readonly options: StorageOptions) {
    // One server process owns this connection. Cross-process writer coordination is outside this store.
    db.exec('PRAGMA journal_mode=DELETE');
    db.exec('PRAGMA synchronous=FULL');
    // The main database cannot grow past max_page_count. DELETE journaling has no retained WAL;
    // a transaction's temporary rollback journal may still briefly use additional disk space.
    db.exec(`PRAGMA page_size=${DEFAULT_PAGE_SIZE}`);
    const pageSize = Number((db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size);
    const pageLimit = Math.floor(options.maxDbBytes / pageSize);
    if (pageLimit < 1) throw new Error('maxDbBytes is too small');
    db.exec(`PRAGMA max_page_count=${pageLimit}`);
    if (Number((db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count) > pageLimit) {
      throw new Error('Existing database exceeds maxDbBytes');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        project TEXT NOT NULL COLLATE BINARY,
        event_id TEXT NOT NULL COLLATE BINARY,
        occurred_at TEXT NOT NULL COLLATE BINARY,
        received_at TEXT NOT NULL COLLATE BINARY,
        environment TEXT NOT NULL COLLATE BINARY,
        type TEXT NOT NULL COLLATE BINARY,
        search_text TEXT NOT NULL COLLATE BINARY,
        payload TEXT NOT NULL,
        PRIMARY KEY (project, event_id)
      );
      CREATE INDEX IF NOT EXISTS events_order ON events (occurred_at DESC, event_id DESC, project DESC);
      CREATE INDEX IF NOT EXISTS events_received ON events (received_at);
    `);
    this.insert = db.prepare(`INSERT INTO events
      (project, event_id, occurred_at, received_at, environment, type, search_text, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, event_id) DO NOTHING`);
    this.deleteExpired = db.prepare('DELETE FROM events WHERE received_at < ?');
    // Deleted pages remain on the SQLite freelist and are reused; the configured page cap
    // bounds the main DB file, but this does not promise that every delete shrinks it.
    this.deleteBeyondCap = db.prepare(`DELETE FROM events WHERE rowid IN (
      SELECT rowid FROM events ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )`);
    this.selectOne = db.prepare('SELECT payload FROM events WHERE project = ? AND event_id = ?');
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Storage is closed');
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original storage error. */ }
      throw error;
    }
  }

  private cutoff(): string {
    const now = this.options.now ?? Date.now;
    const cutoffMs = now() - this.options.retentionDays * DAY_MS;
    if (!Number.isFinite(cutoffMs)) throw new Error('Invalid server time');
    return new Date(cutoffMs).toISOString();
  }

  private prune(): void {
    this.deleteExpired.run(this.cutoff());
    this.deleteBeyondCap.run(this.options.maxEvents);
  }

  async writeBatch(events: ErrorEventRecord[]): Promise<WriteResult> {
    this.ensureOpen();
    if (Array.isArray(events) && events.length > this.options.maxEvents) {
      throw new Error('Batch exceeds maxEvents');
    }
    const receivedAt = timestamp(this.options.now ?? Date.now);
    const normalized = normalizeEvents(events, receivedAt);
    const payloads = normalized.map(event => JSON.stringify(event));
    return this.transaction(() => {
      this.prune();
      let stored = 0;
      normalized.forEach((event, index) => {
        const search = `${event.message} ${event.page} ${event.eventId} ${event.release} ${event.network?.url ?? ''}`.toLocaleLowerCase();
        stored += Number(this.insert.run(event.project, event.eventId, event.occurredAt, receivedAt,
          event.environment, event.type, search, payloads[index]).changes);
      });
      this.prune();
      return { accepted: events.length, stored, duplicates: events.length - stored };
    });
  }

  list(filter: EventFilter): EventPage {
    this.ensureOpen();
    const from = dateBoundary(filter.from);
    const to = dateBoundary(filter.to);
    const cursor = parseCursor(filter.cursor);
    const query = (filter.query ?? '').toLocaleLowerCase();
    if (query.length > 8192) throw new Error('Invalid query filter');
    const limit = pageLimit(filter.limit);
    this.transaction(() => this.prune());
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter.project) { clauses.push('project = ?'); args.push(filter.project); }
    if (filter.environment) { clauses.push('environment = ?'); args.push(filter.environment); }
    if (filter.type) { clauses.push('type = ?'); args.push(filter.type); }
    if (from) { clauses.push('occurred_at >= ?'); args.push(from); }
    if (to) { clauses.push('occurred_at <= ?'); args.push(to); }
    if (query) { clauses.push('instr(search_text, ?) > 0'); args.push(query); }
    if (cursor) {
      clauses.push('(occurred_at < ? OR (occurred_at = ? AND event_id < ?) OR (occurred_at = ? AND event_id = ? AND project < ?))');
      args.push(cursor[0], cursor[0], cursor[1], cursor[0], cursor[1], cursor[2]);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT payload, occurred_at, event_id, project FROM events ${where}
      ORDER BY occurred_at DESC, event_id DESC, project DESC LIMIT ?`).all(...args, limit + 1) as Row[];
    const events = rows.slice(0, limit).map(row => JSON.parse(row.payload) as ErrorEventRecord);
    const last = rows[limit - 1];
    return {
      events,
      ...(rows.length > limit && last
        ? { nextCursor: Buffer.from(JSON.stringify([last.occurred_at, last.event_id, last.project])).toString('base64url') }
        : {}),
    };
  }

  get(project: string, eventId: string): ErrorEventRecord | null {
    this.ensureOpen();
    this.transaction(() => this.prune());
    const row = this.selectOne.get(project, eventId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ErrorEventRecord : null;
  }

  async maintain(): Promise<void> {
    this.ensureOpen();
    this.transaction(() => this.prune());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

class JsonlStorage implements MicroStorage {
  readonly mode = 'jsonl' as const;
  readonly queryable = false;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();

  // The promise queue serializes this instance only; separate processes must not share dataDir.
  constructor(private readonly options: StorageOptions) {}

  private file(index: number): string {
    return join(this.options.dataDir, index === 0 ? 'events.jsonl' : `events.${index}.jsonl`);
  }

  private async recoverTail(): Promise<number> {
    let handle;
    try { handle = await open(this.file(0), 'r+'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return 0;
      const lastByte = Buffer.alloc(1);
      if ((await handle.read(lastByte, 0, 1, size - 1)).bytesRead !== 1) throw new Error('JSONL log changed during recovery');
      if (lastByte[0] === 10) return size;
      let end = size;
      while (end > 0) {
        const length = Math.min(64 * 1024, end);
        const chunk = Buffer.allocUnsafe(length);
        if ((await handle.read(chunk, 0, length, end - length)).bytesRead !== length) {
          throw new Error('JSONL log changed during recovery');
        }
        const newline = chunk.lastIndexOf(10);
        if (newline >= 0) {
          const keep = end - length + newline + 1;
          await handle.truncate(keep);
          await handle.sync();
          return keep;
        }
        end -= length;
      }
      await handle.truncate(0);
      await handle.sync();
      return 0;
    } finally {
      await handle.close();
    }
  }

  async initialize(): Promise<void> { await this.recoverTail(); }

  private async rotate(): Promise<void> {
    await rm(this.file(this.options.logFiles - 1), { force: true });
    for (let index = this.options.logFiles - 2; index >= 0; index--) {
      try { await rename(this.file(index), this.file(index + 1)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  async writeBatch(events: ErrorEventRecord[]): Promise<WriteResult> {
    if (this.closed) throw new Error('Storage is closed');
    // Snapshot and validate before queueing so caller changes cannot alter a pending append.
    const normalized = normalizeEvents(events, timestamp(this.options.now ?? Date.now));
    const content = normalized.map(event => `${JSON.stringify(event)}\n`).join('');
    const bytes = Buffer.byteLength(content);
    if (bytes > this.options.logFileBytes) throw new Error('JSONL batch exceeds logFileBytes');
    const write = this.pending.then(async () => {
      // A failed append or crash may leave a partial line. Drop only bytes after the
      // last newline before accepting another write; those tail bytes are lost.
      const size = await this.recoverTail();
      if (size + bytes > this.options.logFileBytes) await this.rotate();
      if (bytes) {
        const handle = await open(this.file(0), 'a');
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      // JSONL is an append log: retries remain separate lines. A failed partial append
      // is not acknowledged; recovery drops its incomplete tail, not completed lines.
      return { accepted: normalized.length, stored: normalized.length, duplicates: 0 };
    });
    this.pending = write.then(() => undefined, () => undefined);
    return write;
  }

  list(_filter: EventFilter): EventPage { throw new Error('JSONL storage does not support queries'); }
  get(_project: string, _eventId: string): ErrorEventRecord | null { throw new Error('JSONL storage does not support queries'); }
  async maintain(): Promise<void> { await this.pending; }
  async close(): Promise<void> {
    this.closed = true;
    await this.pending;
  }
}

export async function createStorage(mode: StorageMode, options: StorageOptions): Promise<MicroStorage> {
  if (!options.dataDir || !Number.isFinite(options.retentionDays) || options.retentionDays <= 0 ||
      !Number.isInteger(options.maxEvents) || options.maxEvents < 1 ||
      !Number.isFinite(options.maxDbBytes) || options.maxDbBytes < DEFAULT_PAGE_SIZE ||
      !Number.isInteger(options.logFileBytes) || options.logFileBytes < 1 ||
      !Number.isInteger(options.logFiles) || options.logFiles < 1) {
    throw new Error('Invalid storage options');
  }
  await mkdir(options.dataDir, { recursive: true });
  if (mode === 'jsonl') {
    const log = new JsonlStorage(options);
    await log.initialize();
    return log;
  }
  if (mode !== 'sqlite') throw new Error('Invalid storage mode');
  const db = new DatabaseSync(join(options.dataDir, 'events.sqlite'));
  try { return new SqliteStorage(db, options); }
  catch (error) { db.close(); throw error; }
}
