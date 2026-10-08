import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, copyFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';

const scratch = await mkdtemp(join(tmpdir(), 'micro-server-smoke-'));
const password = randomBytes(24).toString('hex'); // Ephemeral, never printed or persisted.
const auth = { Authorization: `Basic ${Buffer.from(`viewer:${password}`).toString('base64')}` };
const origin = 'http://127.0.0.1:5173';
const event = {
  schemaVersion: 1, eventId: randomUUID(), project: 'my-web', environment: 'test',
  release: 'micro-smoke', sdkVersion: '0.1.0', occurredAt: new Date().toISOString(),
  viewId: 'synthetic-view', sequence: 1, elapsedMs: 0, type: 'manual',
  message: 'Synthetic micro server persistence check', page: `${origin}/`, runtime: 'browser',
};
let child;
let address;

async function stop() {
  if (!child) return;
  const processToStop = child;
  child = undefined;
  if (processToStop.exitCode === null && processToStop.signalCode === null) {
    const closed = once(processToStop, 'exit');
    processToStop.kill('SIGTERM');
    const deadline = setTimeout(() => processToStop.kill('SIGKILL'), 12_000);
    try { await closed; } finally { clearTimeout(deadline); }
  }
}

async function start(mode) {
  const probe = createServer();
  await new Promise((done, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', done); });
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MICRO_')));
  child = spawn(process.execPath, [resolve('dist/micro-server/server.mjs')], {
    env: { ...env, MICRO_HOST: '127.0.0.1', MICRO_PORT: String(port), MICRO_STORAGE: mode,
      MICRO_DATA_DIR: join(scratch, mode), MICRO_PROJECTS: 'my-web',
      MICRO_ALLOWED_ORIGINS: origin, MICRO_VIEWER_PASSWORD: password },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-2000); });
  address = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited before ready: ${diagnostics}`);
    try { if ((await fetch(`${address}/api/health`)).ok) return; } catch { /* Wait for listening. */ }
    await delay(100);
  }
  throw new Error('Server did not become ready within 5 seconds');
}

async function send() {
  const response = await fetch(`${address}/api/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ schemaVersion: 1, events: [event] }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  await start('sqlite');
  assert.equal((await fetch(`${address}/api/events`)).status, 401);
  assert.equal((await fetch(address)).status, 401);
  const viewer = await fetch(address, { headers: auth });
  assert.equal(viewer.status, 200);
  assert.match(await viewer.text(), /mode:'live'/);
  assert.deepEqual(await send(), { accepted: 1, stored: 1, duplicates: 0 });
  assert.deepEqual(await send(), { accepted: 1, stored: 0, duplicates: 1 });
  await stop();
  await start('sqlite');
  const persisted = await (await fetch(`${address}/api/events?project=my-web`, { headers: auth })).json();
  assert.equal(persisted.events.length, 1);
  assert.equal(persisted.events[0].eventId, event.eventId);
  assert.equal((await fetch(`${address}/events.sqlite`, { headers: auth })).status, 404);
  await stop();

  await start('jsonl');
  await send();
  await send();
  assert.equal((await fetch(`${address}/api/events`, { headers: auth })).status, 501);
  await stop();
  const lines = (await readFile(join(scratch, 'jsonl/events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  const destination = join(scratch, 'export.json');
  execFileSync(process.execPath, [resolve('dist/micro-server/export.mjs'), join(scratch, 'jsonl'), destination], { stdio: 'pipe' });
  const imported = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(imported.schemaVersion, 1);
  assert.equal(imported.partial, true);
  assert.equal(imported.events.length, 1);
  assert.equal(imported.events[0].eventId, event.eventId);
  await mkdir('output/micro-server-smoke', { recursive: true });
  await copyFile(destination, 'output/micro-server-smoke/events.json');
  console.log('Built-server smoke PASS: authenticated viewer, credentialless CORS ingest, SQLite restart/dedupe, JSONL-only storage, viewer-compatible export.');
} finally {
  await stop();
  await rm(scratch, { recursive: true, force: true });
}
