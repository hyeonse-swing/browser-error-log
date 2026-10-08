import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const out = 'dist/micro-server';
await rm(`${out}/public`, { recursive: true, force: true });
await mkdir(`${out}/public`, { recursive: true });
await build({
  entryPoints: ['examples/micro-server/src/main.ts'],
  outfile: `${out}/server.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  tsconfig: 'tsconfig.json',
  logLevel: 'warning',
});
await build({
  entryPoints: ['scripts/export-micro-logs.mjs'],
  outfile: `${out}/export.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  tsconfig: 'tsconfig.json',
  logLevel: 'warning',
});
for (const name of ['assets', 'favicon.svg', 'history-example.json']) {
  await cp(`dist/viewer/${name}`, `${out}/public/${name}`, { recursive: true });
}
const index = await readFile('dist/viewer/index.html', 'utf8');
await writeFile(`${out}/public/index.html`, index.replace('</head>',
  `<script>window.__ERROR_LOG_VIEWER_CONFIG__={mode:'live',title:'Browser Error Log'};</script></head>`));
await cp('packages/browser/dist/index.js', `${out}/public/sdk.js`);
for (const name of ['install.html', 'demo.html']) {
  await cp('examples/micro-server/install.html', `${out}/public/${name}`);
}
await cp('examples/micro-server/Dockerfile', `${out}/Dockerfile`);
console.log('Micro server built: dist/micro-server (Node.js built-ins only; no runtime npm install).');
