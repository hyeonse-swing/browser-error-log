import { build } from 'esbuild';

await build({
  entryPoints: ['apps/local-collector/server.ts'],
  outfile: 'dist/collector/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  logLevel: 'warning',
});
