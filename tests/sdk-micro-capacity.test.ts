import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { init, type BrowserErrorLogDeliveryClient } from '../packages/browser/src/index.ts';
import { readConfig } from '../examples/micro-server/src/config.ts';
import { createMicroServer } from '../examples/micro-server/src/server.ts';
import { createStorage } from '../examples/micro-server/src/storage.ts';
import type { MicroStorage } from '../examples/micro-server/src/types.ts';

describe('SDK to bounded micro collector', () => {
  it('delivers a default SDK batch when the collector retains fewer events than the batch contains', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'browser-error-capacity-'));
    let server: Server | undefined;
    let storage: MicroStorage | undefined;
    let client: BrowserErrorLogDeliveryClient | undefined;
    try {
      const config = { ...readConfig({ MICRO_PROJECTS: 'test', MICRO_MAX_EVENTS: '2' }),
        dataDir: folder, publicDir: folder };
      storage = await createStorage('sqlite', config);
      const writes: string[][] = [];
      const writeBatch = storage.writeBatch.bind(storage);
      storage.writeBatch = async events => {
        const result = await writeBatch(events);
        writes.push(events.map(event => event.eventId));
        return result;
      };
      server = createMicroServer(config, storage);
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Micro collector did not listen');

      client = init({ project: 'test', endpoint: `http://127.0.0.1:${address.port}/api/events`,
        captureNetwork: false, flushIntervalMs: 60_000, deliveryStatusLimit: 4 });
      const ids = Array.from({ length: 4 }, (_, index) => client!.captureException(`error ${index}`)!);
      await client.flush();

      expect(writes).toEqual([ids.slice(0, 2), ids.slice(2)]);
      expect(client.getStats()).toEqual({ queued: 0, sent: 4, dropped: 0 });
      expect(ids.map(id => client!.getDeliveryStatus(id).state)).toEqual(Array(4).fill('transport-accepted'));
      expect(storage.list({}).events.map(event => event.eventId).sort()).toEqual(ids.slice(2).sort());
    } finally {
      client?.destroy();
      if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
      await storage?.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
