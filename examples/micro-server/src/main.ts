import { fileURLToPath } from 'node:url';
import { readConfig } from './config.ts';
import { createStorage } from './storage.ts';
import { createMicroServer } from './server.ts';

const config = readConfig({
  ...process.env,
  MICRO_PUBLIC_DIR: process.env.MICRO_PUBLIC_DIR ?? fileURLToPath(new URL('./public', import.meta.url)),
});
const storage = await createStorage(config.mode, config);
const server = createMicroServer(config, storage);
let stopping = false;
const maintenance = setInterval(() => {
  void storage.maintain().catch(() => console.error('Storage maintenance failed; check disk availability.'));
}, 60_000);
maintenance.unref();

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenance);
  // Finish accepted writes before closing the single storage writer.
  const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
  deadline.unref();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  clearTimeout(deadline);
  await storage.close();
}

server.on('error', error => {
  console.error('Micro server could not listen:', 'code' in error ? error.code : 'unknown error');
  process.exitCode = 1;
  void stop();
});
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
server.listen(config.port, config.host, () => {
  console.log(`Micro collector (${config.mode}): ${config.publicUrl ?? `http://127.0.0.1:${config.port}`}`);
  console.log(`Storage: ${config.dataDir}; single process, bounded retention.`);
});
