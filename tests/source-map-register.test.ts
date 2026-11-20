import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let directory: string;
let server: Server;
let port: number;
let requests: Array<{ authorization: string; body: { manifest: Record<string, unknown>; mapBase64: string } }>;
let status = 201;
let redirect = false;
let htmlResponse = false;
const token = 'test-token-of-at-least-thirty-two-characters';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'source-map-ci-'));
  requests = [];
  status = 201;
  redirect = false;
  htmlResponse = false;
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ authorization: String(request.headers.authorization), body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (redirect) response.setHeader('Location', `http://127.0.0.1:${port}/other`);
    response.writeHead(redirect ? 302 : status, { 'content-type': htmlResponse ? 'text/html' : 'application/json' });
    response.end(htmlResponse ? '<title>Sign in</title>' : JSON.stringify({ status: status === 201 ? 'created' : 'duplicate' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

async function writePair(relativePath: string, content = 'throw Error("test");\n') {
  const file = join(directory, relativePath);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
  await writeFile(`${file}.map`, JSON.stringify({
    version: 3, file: relativePath.split('/').at(-1), sources: ['src/app.ts'],
    sourcesContent: ['throw Error("test");\n'], names: [], mappings: 'AAAA',
  }));
}

async function run(overrides: Record<string, string> = {}, env: NodeJS.ProcessEnv = { ...process.env, BEL_SOURCE_MAP_TOKEN: token }) {
  const options = {
    'build-dir': directory,
    'asset-base-url': 'https://cdn.example/assets/',
    'collector-url': `http://127.0.0.1:${port}`,
    project: 'shop', environment: 'production', release: 'build-42',
    ...overrides,
  };
  const args = ['scripts/register-source-maps.mjs', ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value])];
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, stdout, stderr };
}

it('posts every nested and hidden JavaScript source map with its exact release identity', async () => {
  await writePair('nested/app.js');
  await writePair('nested/.hidden.js', 'console.log(2);\n');
  const first = await run();
  expect(first.code).toBe(0);
  expect(requests.map(item => item.body.manifest.assetUrl)).toEqual([
    'https://cdn.example/assets/nested/.hidden.js',
    'https://cdn.example/assets/nested/app.js',
  ]);
  for (const { authorization, body } of requests) {
    expect(authorization).toBe(`Bearer ${token}`);
    expect(body.manifest).toMatchObject({ project: 'shop', environment: 'production', release: 'build-42' });
    expect(body.manifest.mapSha256).toBe(createHash('sha256').update(Buffer.from(body.mapBase64, 'base64')).digest('hex'));
  }
  expect(first.stdout).not.toContain(token);
  status = 200;
  expect((await run()).code).toBe(0);
});

it('validates the whole build before writing and rejects missing credentials, insecure origins, redirects and conflicts', async () => {
  await writePair('valid.js');
  await writeFile(join(directory, 'orphan.js.map'), '{"version":3,"sources":[],"mappings":""}');
  expect((await run()).code).not.toBe(0);
  expect(requests).toHaveLength(0);
  await rm(join(directory, 'orphan.js.map'));

  expect((await run({}, { ...process.env, BEL_SOURCE_MAP_TOKEN: '' })).code).not.toBe(0);
  const insecure = await run({ 'collector-url': 'http://remote.example' });
  expect(insecure.code).not.toBe(0);
  expect(insecure.stderr).toContain('requires HTTPS');
  expect(requests).toHaveLength(0);

  redirect = true;
  expect((await run()).code).not.toBe(0);
  expect(requests).toHaveLength(1);
  redirect = false;
  status = 409;
  const conflict = await run();
  expect(conflict.code).not.toBe(0);
  expect(conflict.stderr).toContain('HTTP 409');
  expect(conflict.stderr).not.toContain(token);
});

it('refuses source map symlinks instead of reading files outside the build', async () => {
  await writePair('app.js');
  await symlink(join(directory, 'app.js.map'), join(directory, 'link.js.map'));
  expect((await run()).code).not.toBe(0);
  expect(requests).toHaveLength(0);
});

it('registers module bundles and requires an affirmative collector receipt', async () => {
  await writePair('app.mjs');
  const collector = { 'collector-url': `http://127.0.0.1:${port}/` };
  expect((await run(collector)).code).toBe(0);
  expect(requests[0].body.manifest.assetUrl).toBe('https://cdn.example/assets/app.mjs');
  status = 200;
  htmlResponse = true;
  const result = await run(collector);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('did not confirm registration');
});
