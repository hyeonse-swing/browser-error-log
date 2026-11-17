import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Verify actual installed contents, including portable skill reference closure.
export function verifyAiBundle(packageDirectory) {
  const pkg = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'));
  const base = resolve(packageDirectory, 'ai');
  const manifest = JSON.parse(readFileSync(resolve(base, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.package, { name: pkg.name, version: pkg.version });
  assert.equal(manifest.benchmarkSdkVersion, '0.2.13');
  for (const required of ['skills/browser-error-log/SKILL.md', 'skills/browser-error-log/references/integration.md', 'skills/browser-error-log/references/collector.md', 'docs/ai.md', 'llms.txt', 'docs/preset-performance-2026-11-17.ko.md', 'docs/benchmarks/2026-11-17-presets/raw.json', 'docs/benchmarks/2026-11-17-presets/summary.json', 'scripts/benchmark-sdk-presets.mjs', 'scripts/fixtures/sdk-preset-benchmark.js']) {
    assert(manifest.files[required], `Missing bundled evidence: ${required}`);
  }
  for (const [path, sha256] of Object.entries(manifest.files)) {
    const file = resolve(base, path);
    assert(file.startsWith(base + '/'), 'Manifest path stays inside AI bundle');
    const bytes = readFileSync(file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, path);
    if (path.endsWith('.md') || path === 'llms.txt') {
      for (const match of bytes.toString('utf8').matchAll(/\]\(([^\s)]+)\)/g)) {
        if (/^(https?:|#)/.test(match[1])) continue;
        const target = resolve(dirname(file), match[1].split('#')[0]);
        assert(target.startsWith(base + '/'), `Local doc link stays in bundle: ${path} -> ${match[1]}`);
        assert(existsSync(target), `Bundled doc link exists: ${path} -> ${match[1]}`);
        if (path.startsWith('skills/')) assert(target.startsWith(resolve(base, 'skills/browser-error-log') + '/'), 'Copied skill is self-contained');
      }
    }
  }
  const raw = JSON.parse(readFileSync(resolve(base, 'docs/benchmarks/2026-11-17-presets/raw.json'), 'utf8'));
  assert.equal(raw.metadata.sdk.version, '0.2.13');
  assert.equal(raw.rows.length, 144);
  console.log(`Installed AI bundle verified: ${pkg.name}@${pkg.version}`);
}
