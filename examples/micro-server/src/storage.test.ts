// @vitest-environment node
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ErrorEventRecord } from 'browser-error-log-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage } from './storage.ts';
import type { MicroStorage, StorageOptions } from './types.ts';

const folders: string[] = [];
const storages: MicroStorage[] = [];

async function options(overrides: Partial<StorageOptions> = {}): Promise<StorageOptions> {
  const dataDir = await mkdtemp(join(tmpdir(), 'micro-storage-'));
  folders.push(dataDir);
  return {
    dataDir,
    retentionDays: 7,
    maxEvents: 10_000,
    maxDbBytes: 64 * 1024 * 1024,
    logFileBytes: 8 * 1024 * 1024,
    logFiles: 3,
    now: () => Date.parse('2026-10-08T00:00:00.000Z'),
    ...overrides,
  };
}

async function storage(mode: 'sqlite' | 'jsonl', settings: StorageOptions): Promise<MicroStorage> {
  const value = await createStorage(mode, settings);
  storages.push(value);
  return value;
}

function event(eventId: string, patch: Partial<ErrorEventRecord> = {}): ErrorEventRecord {
  return {
    schemaVersion: 1,
    eventId,
    project: 'web',
    environment: 'production',
    release: 'r1',
    sdkVersion: '0.1.0',
    occurredAt: '2026-10-02T09:00:00+09:00',
    receivedAt: '1999-01-01T00:00:00.000Z',
    viewId: 'view-1',
    sequence: 1,
    elapsedMs: 1,
    type: 'javascript',
    message: 'A failure',
    page: '/home',
    runtime: 'browser',
    ...patch,
  };
}

afterEach(async () => {
  await Promise.all(storages.splice(0).map(value => value.close()));
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

describe('SQLite micro storage', () => {
  it('persists normalized records across restart and deduplicates project-scoped retries', async () => {
    const settings = await options();
    const first = await storage('sqlite', settings);
    expect(await first.writeBatch([event('id', { project: 'one' }), event('id', { project: 'two' })]))
      .toEqual({ accepted: 2, stored: 2, duplicates: 0 });
    expect(await first.writeBatch([event('id', { project: 'one', message: 'retry' })]))
      .toEqual({ accepted: 1, stored: 0, duplicates: 1 });
    await first.close();
    const reopened = await storage('sqlite', settings);
    expect(reopened.get('one', 'id')).toMatchObject({
      message: 'A failure',
      occurredAt: '2026-10-02T00:00:00.000Z',
      receivedAt: '2026-10-08T00:00:00.000Z',
    });
    expect(reopened.get('two', 'id')?.project).toBe('two');
    expect(reopened.list({}).events).toHaveLength(2);
  });

  it('rejects an invalid batch before any insert or retention mutation', async () => {
    let clock = Date.parse('2026-10-08T00:00:00.000Z');
    const db = await storage('sqlite', await options({ retentionDays: 1, now: () => clock }));
    await db.writeBatch([event('existing')]);
    clock += 2 * 86_400_000;
    const invalid = { ...event('bad'), message: { html: '<script>' } } as unknown as ErrorEventRecord;
    await expect(db.writeBatch([event('would-insert'), invalid])).rejects.toThrow('Invalid event record');
    // Rewind the injected clock: if the rejected batch had pruned, the old row would be gone.
    clock -= 2 * 86_400_000;
    expect(db.get('web', 'existing')).not.toBeNull();
    expect(db.get('web', 'would-insert')).toBeNull();
    clock += 2 * 86_400_000;
    expect(db.list({}).events).toEqual([]);
  });

  it('filters instants and searches, with deterministic keyset pages and bounded results', async () => {
    const db = await storage('sqlite', await options());
    await db.writeBatch([
      event('older', { occurredAt: '2026-10-02T09:00:00+09:00' }),
      event('same', { project: 'alpha', occurredAt: '2026-10-02T00:15:00Z', message: 'Needle error' }),
      event('same', { project: 'beta', occurredAt: '2026-10-02T00:15:00.000Z', message: 'Needle error' }),
      event('newer', { occurredAt: '2026-10-02T00:30:00Z', type: 'network', network: { method: 'GET', url: '/needle', durationMs: 1 } }),
    ]);
    expect(db.list({ from: '2026-10-02T09:15:00+09:00', to: '2026-10-02T00:30:00Z' }).events.map(row => row.eventId))
      .toEqual(['newer', 'same', 'same']);
    expect(db.list({ query: 'NEEDLE' }).events.map(row => row.eventId)).toEqual(['newer', 'same', 'same']);
    expect(db.list({ type: 'network', project: 'web' }).events.map(row => row.eventId)).toEqual(['newer']);
    const first = db.list({ limit: 1 });
    await db.writeBatch([event('newest', { occurredAt: '2026-10-03T00:00:00Z' })]);
    const second = db.list({ limit: 1, cursor: first.nextCursor });
    const third = db.list({ limit: 1, cursor: second.nextCursor });
    expect([first.events[0].eventId, second.events[0].project, third.events[0].project])
      .toEqual(['newer', 'beta', 'alpha']);
    expect(() => db.list({ cursor: 'invalid' })).toThrow('Invalid cursor');
    expect(() => db.list({ from: 'yesterday' })).toThrow('Invalid date filter');
    const many = Array.from({ length: 105 }, (_, index) => event(`many-${index}`));
    await db.writeBatch(many);
    expect(db.list({ limit: 999 }).events).toHaveLength(100);
  });

  it('expires by server receivedAt and enforces the oldest-received event cap', async () => {
    let clock = Date.parse('2026-10-08T00:00:00.000Z');
    const db = await storage('sqlite', await options({ retentionDays: 1, maxEvents: 2, now: () => clock }));
    await db.writeBatch([event('old-occurrence', { occurredAt: '2020-01-01T00:00:00Z' })]);
    expect(db.get('web', 'old-occurrence')).not.toBeNull();
    clock += 60_000;
    await db.writeBatch([event('second')]);
    clock += 60_000;
    await db.writeBatch([event('third')]);
    expect(db.get('web', 'old-occurrence')).toBeNull();
    expect(db.list({}).events.map(row => row.eventId).sort()).toEqual(['second', 'third']);
    clock += 2 * 86_400_000;
    expect(db.get('web', 'second')).toBeNull();
    await db.writeBatch([event('fourth')]);
    expect(db.list({}).events.map(row => row.eventId)).toEqual(['fourth']);
    clock += 2 * 86_400_000;
    await db.maintain();
    expect(db.list({}).events).toEqual([]);
  });

  it('rolls back a batch when the SQLite page cap is reached', async () => {
    const settings = await options({ maxDbBytes: 64 * 1024 });
    const db = await storage('sqlite', settings);
    const large = Array.from({ length: 30 }, (_, index) => event(`large-${index}`, { message: 'x'.repeat(7000) }));
    await expect(db.writeBatch(large)).rejects.toThrow();
    expect(db.list({}).events).toEqual([]);
    expect((await stat(join(settings.dataDir, 'events.sqlite'))).size).toBeLessThanOrEqual(settings.maxDbBytes);
  });

  it('rejects batches larger than maxEvents without pruning or changing stored rows', async () => {
    let clock = Date.parse('2026-10-08T00:00:00.000Z');
    const db = await storage('sqlite', await options({ maxEvents: 1, retentionDays: 1, now: () => clock }));
    await db.writeBatch([event('existing')]);
    clock += 2 * 86_400_000;
    await expect(db.writeBatch([event('new-1'), event('new-2')])).rejects.toThrow('Batch exceeds maxEvents');
    clock -= 2 * 86_400_000;
    expect(db.list({}).events.map(row => row.eventId)).toEqual(['existing']);
  });
});

describe('JSONL micro storage', () => {
  it('appends normalized duplicate lines and rejects queries', async () => {
    const settings = await options();
    const log = await storage('jsonl', settings);
    expect(await log.writeBatch([event('same'), event('same')]))
      .toEqual({ accepted: 2, stored: 2, duplicates: 0 });
    await log.close();
    const lines = (await readFile(join(settings.dataDir, 'events.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ eventId: 'same', occurredAt: '2026-10-02T00:00:00.000Z', receivedAt: '2026-10-08T00:00:00.000Z' }),
      expect.objectContaining({ eventId: 'same' }),
    ]);
    expect(() => log.list({})).toThrow('does not support queries');
    expect(() => log.get('web', 'same')).toThrow('does not support queries');
  });

  it('serializes concurrent writes and bounds rotated file count and bytes', async () => {
    const settings = await options({ logFileBytes: 900, logFiles: 3 });
    const log = await storage('jsonl', settings);
    const writes = await Promise.all(Array.from({ length: 12 }, (_, index) => log.writeBatch([event(`id-${index}`)])));
    expect(writes.every(result => result.stored === 1)).toBe(true);
    await log.close();
    const names = (await readdir(settings.dataDir)).sort();
    expect(names).toEqual(['events.1.jsonl', 'events.2.jsonl', 'events.jsonl']);
    const ids: string[] = [];
    for (const name of names) {
      expect((await stat(join(settings.dataDir, name))).size).toBeLessThanOrEqual(settings.logFileBytes);
      const content = await readFile(join(settings.dataDir, name), 'utf8');
      expect(content.endsWith('\n')).toBe(true);
      ids.push(...content.trim().split('\n').map(line => (JSON.parse(line) as ErrorEventRecord).eventId));
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('id-11');
  });

  it('keeps a batch in one file and does not acknowledge a failed append', async () => {
    const settings = await options({ logFileBytes: 900 });
    const log = await storage('jsonl', settings);
    await log.writeBatch([event('first')]);
    await log.writeBatch([event('batch-1'), event('batch-2')]);
    const files = await readdir(settings.dataDir);
    expect(files).toContain('events.1.jsonl');
    const current = await readFile(join(settings.dataDir, 'events.jsonl'), 'utf8');
    expect(current).toContain('batch-1');
    expect(current).toContain('batch-2');

    await rm(join(settings.dataDir, 'events.jsonl'));
    await mkdir(join(settings.dataDir, 'events.jsonl'));
    await expect(log.writeBatch([event('cannot-write')])).rejects.toThrow();
    await rm(join(settings.dataDir, 'events.jsonl'), { recursive: true });
    expect((await log.writeBatch([event('recovered')])).stored).toBe(1);
  });

  it('drops only an incomplete tail on reopen and before later appends', async () => {
    const settings = await options();
    const path = join(settings.dataDir, 'events.jsonl');
    const first = await storage('jsonl', settings);
    await first.writeBatch([event('complete-1')]);
    await first.close();
    const complete = await readFile(path, 'utf8');
    await appendFile(path, '{"schemaVersion":1');

    const reopened = await storage('jsonl', settings);
    expect(await readFile(path, 'utf8')).toBe(complete);
    await reopened.writeBatch([event('complete-2')]);
    await appendFile(path, '{"eventId":"interrupted"');
    await reopened.writeBatch([event('complete-3')]);
    await reopened.close();
    const content = await readFile(path, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    expect(content.trim().split('\n').map(line => (JSON.parse(line) as ErrorEventRecord).eventId))
      .toEqual(['complete-1', 'complete-2', 'complete-3']);
  });
});
