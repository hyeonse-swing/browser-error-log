import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
const base = { bundle: true, platform: 'browser', target: ['es2020'], sourcemap: true, minify: true, tsconfig: 'tsconfig.json', logLevel: 'warning' };
for (const [pkg, source] of [['protocol', 'index.ts'], ['browser', 'index.ts'], ['react', 'index.tsx']]) {
  const dir = `packages/${pkg}/dist`;
  await mkdir(dir, { recursive: true });
  for (const [format, extension] of [['esm', 'js'], ['cjs', 'cjs']]) {
    const result = await build({ ...base, entryPoints: [`packages/${pkg}/src/${source}`], outfile: `${dir}/index.${extension}`, format, external: ['react', 'react/jsx-runtime'], metafile: true, write: false });
    for (const file of result.outputFiles) await writeFile(file.path, file.contents);
    if (pkg === 'browser' && format === 'esm') {
      const bytes = gzipSync(result.outputFiles.find(f => f.path.endsWith('.js')).contents).length;
      console.log(`Browser SDK gzip: ${bytes} bytes (budget: 20480)`);
      if (bytes > 20480) throw new Error('Browser SDK exceeded 20 KiB gzip budget');
    }
  }
}
execFileSync('node', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
for (const pkg of ['protocol', 'browser', 'react']) await cp(`dist/types/${pkg}/src`, `packages/${pkg}/dist`, { recursive: true });
