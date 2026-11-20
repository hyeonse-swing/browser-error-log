import { createHash, webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ErrorEventRecord } from '@ihyeon/browser-error-log-protocol';
import {
  SourceMapInputError, emptySourceMaps, prepareSourceMap, registerSourceMap,
  generatedAssetUrls, removeSourceMap, resolveComponentStack, resolveStack, sourceExcerpt,
} from './source-maps';

beforeAll(() => vi.stubGlobal('crypto', webcrypto));

const bundleSha256 = 'a'.repeat(64);
const assetUrl = 'https://example.test/assets/app.js';

function file(text: string, name: string): File {
  const bytes = new TextEncoder().encode(text);
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } as File;
}

async function prepared(
  release = 'A',
  map: Record<string, unknown> = {
    version: 3, file: 'app.js', sources: ['src/a.ts'], names: [], mappings: 'AAAA',
  },
  changes: Record<string, unknown> = {},
) {
  const mapText = JSON.stringify(map);
  const mapSha256 = createHash('sha256').update(mapText).digest('hex');
  const manifest = {
    schemaVersion: 1, project: 'shop', environment: 'production', release,
    assetUrl, bundleSha256, mapSha256, ...changes,
  };
  return prepareSourceMap(file(JSON.stringify(manifest), 'map-registration.json'), file(mapText, 'app.js.map'));
}

function event(stack?: string, release = 'A', changes: Partial<ErrorEventRecord> = {}) {
  return { project: 'shop', environment: 'production', release, stack, ...changes };
}

describe('private release source maps', () => {
  it('distinguishes two releases of the same URL and maps both stack syntaxes', async () => {
    const a = await prepared();
    const b = await prepared('B', {
      version: 3, file: 'app.js', sources: ['src/b.ts'], names: [], mappings: 'AASA',
    });
    let registry = registerSourceMap(emptySourceMaps(), b);
    registry = registerSourceMap(registry, a);
    expect(resolveStack(event(`Error: fault\n    at run (${assetUrl}:1:1)`), registry)[0]).toMatchObject({
      generated: { url: assetUrl, line: 1, column: 1 }, original: { source: 'src/a.ts', line: 1, column: 1 },
    });
    expect(resolveStack(event(`run@${assetUrl}:1:1`, 'B'), registry)[0]).toMatchObject({
      original: { source: 'src/b.ts', line: 10, column: 1 },
    });
    expect(resolveStack(event(`@${assetUrl}:1:1`, 'B'), registry)[0].original?.source).toBe('src/b.ts');
  });

  it('matches the whole project, environment and origin; refuses absent or unknown releases', async () => {
    const registry = registerSourceMap(emptySourceMaps(), await prepared());
    const frame = `at fn (${assetUrl}:1:1)`;
    expect(resolveStack(event(frame, 'unknown'), registry)[0].reason).toBe('unknown-release');
    expect(resolveStack(event(frame, 'B'), registry)[0].reason).toBe('no-registration');
    expect(resolveStack(event(frame, 'A', { project: 'other' }), registry)[0].reason).toBe('no-registration');
    expect(resolveStack(event(frame, 'A', { environment: 'staging' }), registry)[0].reason).toBe('no-registration');
    expect(resolveStack(event('at fn (https://cdn.example.test/assets/app.js:1:1)'), registry)[0].reason).toBe('no-registration');
    expect(resolveStack(event('at fn (https://example.test/different/app.js:1:1)'), registry)[0].reason).toBe('no-registration');
    expect(resolveStack(event(), registry)).toEqual([{ raw: '', reason: 'no-stack' }]);
  });

  it('keeps exact generated columns and returns the segment original location without interpolation', async () => {
    const registry = registerSourceMap(emptySourceMaps(), await prepared('A', {
      version: 3, file: 'app.js', sources: ['src/café.ts'], names: [], mappings: 'AAAA,GAAO',
    }));
    const frame = resolveStack(event(`run@${assetUrl}:1:4`), registry)[0];
    expect(frame.generated).toEqual({ url: assetUrl, line: 1, column: 4 });
    expect(frame.original).toEqual({ source: 'src/café.ts', line: 1, column: 8 });
    expect(resolveStack(event(`run@${assetUrl}:1:5`), registry)[0].original?.column).toBe(8);
  });

  it('preserves a safe relative author directory when two files share a basename', async () => {
    const cart = await prepared('A', {
      version: 3, file: 'app.js', sources: ['features/cart/index.ts'], names: [], mappings: 'AAAA',
    });
    const orders = await prepared('B', {
      version: 3, file: 'app.js', sources: ['features/orders/index.ts'], names: [], mappings: 'AAAA',
    });
    const registry = registerSourceMap(registerSourceMap(emptySourceMaps(), cart), orders);
    expect(resolveStack(event(`at fn (${assetUrl}:1:1)`), registry)[0].original?.source).toBe('features/cart/index.ts');
    expect(resolveStack(event(`at fn (${assetUrl}:1:1)`, 'B'), registry)[0].original?.source).toBe('features/orders/index.ts');
  });

  it('combines a safe relative sourceRoot with a relative file', async () => {
    const entry = await prepared('A', {
      version: 3, file: 'app.js', sourceRoot: 'src/', sources: ['cart/index.ts'], names: [], mappings: 'AAAA',
    });
    const registry = registerSourceMap(emptySourceMaps(), entry);
    expect(resolveStack(event(`at fn (${assetUrl}:1:1)`), registry)[0].original?.source).toBe('src/cart/index.ts');
    expect(entry.trace.sourceRoot).toBeUndefined();
  });

  it('reports unmapped, malformed and unrelated frames without preventing later mappings', async () => {
    const registry = registerSourceMap(emptySourceMaps(), await prepared('A', {
      version: 3, file: 'app.js', sources: ['src/a.ts'], names: [], mappings: 'AAAA;A',
    }));
    const frames = resolveStack(event([
      'Error: fault', '', '    at malformed (https://example.test/assets/app.js:1)',
      `    at ok (${assetUrl}:1:1)`, `fn@${assetUrl}:2:1`,
    ].join('\n')), registry);
    expect(frames.map(frame => frame.reason)).toEqual(['invalid-frame', undefined, 'no-mapping']);
    expect(frames[1].original?.source).toBe('src/a.ts');
  });

  it('keeps unfamiliar native frames when an ordinary error header precedes them', async () => {
    const registry = registerSourceMap(emptySourceMaps(), await prepared());
    const frames = resolveStack(event(`TypeError: failed\nfoo@native-code:2:3\nrun@${assetUrl}:1:1`), registry);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ raw: 'foo@native-code:2:3', reason: 'unrecognized-frame' });
    expect(frames[1].original?.source).toBe('src/a.ts');
  });

  it('quarantines a conflicting registration until explicit removal, and identical imports are idempotent', async () => {
    const a = await prepared();
    const conflicting = await prepared('A', {
      version: 3, file: 'app.js', sources: ['src/other.ts'], names: [], mappings: 'AAAA',
    });
    const initial = registerSourceMap(emptySourceMaps(), a);
    expect(registerSourceMap(initial, a)).toBe(initial);
    const quarantined = registerSourceMap(initial, conflicting);
    expect(quarantined.conflicts.has(a.key)).toBe(true);
    expect(resolveStack(event(`at fn (${assetUrl}:1:1)`), quarantined)[0].reason).toBe('registration-conflict');
    expect(registerSourceMap(quarantined, a)).toBe(quarantined);
    const cleared = removeSourceMap(quarantined, a.key);
    expect(cleared.entries.size).toBe(0);
    expect(cleared.conflicts.size).toBe(0);
    expect(resolveStack(event(`at fn (${assetUrl}:1:1)`), cleared)[0].reason).toBe('no-registration');
    expect(registerSourceMap(cleared, conflicting).entries.get(a.key)?.manifest.mapSha256).toBe(conflicting.mapSha256);
    const differentBundle = await prepared('A', {
      version: 3, file: 'app.js', sources: ['src/a.ts'], names: [], mappings: 'AAAA',
    }, { bundleSha256: 'b'.repeat(64) });
    expect(registerSourceMap(initial, differentBundle).conflicts.has(a.key)).toBe(true);
  });

  it('never renders sourceRoot, absolute host paths or source contents', async () => {
    const map = {
      version: 3, file: 'app.js', sources: ['webpack://private/Users/alice/src/errors/fault.ts'],
      sourceRoot: 'https://user:secret@private.example.test/source/',
      sourcesContent: ['private token body'], names: ['secretName'], mappings: 'AAAA',
    };
    const entry = await prepared('A', map);
    expect(entry.trace.sourcesContent).toBeUndefined();
    expect(entry.trace.sourceRoot).toBeUndefined();
    expect(entry.trace.sources).toEqual(['src/errors/fault.ts']);
    expect(JSON.stringify(entry.trace)).not.toMatch(/alice|secret|private token body|secretName/);
    expect(resolveStack(event(`at fn (${assetUrl}:1:1)`), registerSourceMap(emptySourceMaps(), entry))[0].original).toEqual({
      source: 'src/errors/fault.ts', line: 1, column: 1,
    });
  });

  it('drops opaque sources and URL authorities before retaining the trace', async () => {
    for (const source of [
      'data:text/plain;base64,c2VjcmV0',
      'blob:https://user:secret@private.example.test/id',
      'https://user:secret@private.example.test',
      String.raw`\\corp\private`,
    ]) {
      const entry = await prepared('A', { version: 3, sources: [source], names: [], mappings: 'AAAA' });
      expect(entry.trace.sources).toEqual([null]);
      expect(JSON.stringify(entry.trace)).not.toMatch(/c2VjcmV0|secret|private|corp/);
      const frame = resolveStack(event(`at fn (${assetUrl}:1:1)`), registerSourceMap(emptySourceMaps(), entry))[0];
      expect(frame.reason).toBe('no-mapping');
      expect(frame.original).toBeUndefined();
    }
    for (const source of [
      'https://user:secret@private.example.test/Users/alice/src/cart.ts',
      'file:///Users/alice/src/cart.ts',
      'webpack://private/./src/cart.ts',
      String.raw`\\corp\private\src\cart.ts`,
    ]) {
      const entry = await prepared('A', { version: 3, sourceRoot: 'build/', sources: [source], names: [], mappings: 'AAAA' });
      expect(entry.trace.sources).toEqual(['src/cart.ts']);
      expect(JSON.stringify(entry.trace)).not.toMatch(/alice|secret|private|corp|build/);
    }
  });

  it('rejects changed map bytes, indexed maps, invalid mappings and mismatched file names', async () => {
    const mapText = JSON.stringify({ version: 3, file: 'app.js', sources: ['src/a.ts'], names: [], mappings: 'AAAA' });
    const manifest = {
      schemaVersion: 1, project: 'shop', environment: 'production', release: 'A', assetUrl,
      bundleSha256, mapSha256: createHash('sha256').update(mapText).digest('hex'),
    };
    await expect(prepareSourceMap(file(JSON.stringify(manifest), 'manifest.json'), file(mapText + ' ', 'map')))
      .rejects.toMatchObject({ code: 'map-hash-mismatch' });
    await expect(prepared('A', { version: 3, sections: [] })).rejects.toMatchObject({ code: 'unsupported-map' });
    await expect(prepared('A', { version: 3, sources: ['src/a.ts'], names: [], mappings: 'ACAA' }))
      .rejects.toMatchObject({ code: 'invalid-map' });
    await expect(prepared('A', { version: 3, sources: ['src/a.ts'], names: [], mappings: 'AAAAA' }))
      .rejects.toMatchObject({ code: 'invalid-map' });
    await expect(prepared('A', { version: 3, file: 'other.js', sources: ['src/a.ts'], names: [], mappings: 'AAAA' }))
      .rejects.toMatchObject({ code: 'invalid-map' });
    await expect(prepared('A', {
      version: 3, file: '앱.js', sources: ['src/a.ts'], names: [], mappings: 'AAAA',
    }, { assetUrl: 'https://example.test/assets/%EC%95%B1.js' })).resolves.toBeTruthy();
    for (const mappings of ['g', 'AA', 'AAAA,A', 'AAAA,g']) {
      await expect(prepared('A', { version: 3, sources: ['src/a.ts'], names: [], mappings }))
        .rejects.toMatchObject({ code: 'invalid-map' });
    }
    for (const mappings of ['A,;', 'A,,A', 'A,', 'AAAggggggE', 'AAAgggggggA']) {
      await expect(prepared('A', { version: 3, sources: ['src/a.ts'], names: [], mappings }))
        .rejects.toMatchObject({ code: 'invalid-map' });
    }
    const wideColumn = await prepared('A', {
      version: 3, sources: ['src/a.ts'], names: [], mappings: 'AAAggggggB',
    });
    expect(resolveStack(event(`at fn (${assetUrl}:1:1)`), registerSourceMap(emptySourceMaps(), wideColumn))[0].original)
      .toEqual({ source: 'src/a.ts', line: 1, column: 536_870_913 });
  });

  it('bounds file reads and registration memory', async () => {
    const large = { size: 20_000, arrayBuffer: vi.fn() } as unknown as File;
    await expect(prepareSourceMap(large, file('{}', 'map'))).rejects.toMatchObject({ code: 'manifest-too-large' });
    expect(large.arrayBuffer).not.toHaveBeenCalled();
    const tooLargeMap = { size: 8 * 1024 * 1024 + 1, arrayBuffer: vi.fn() } as unknown as File;
    const manifest = file(JSON.stringify({
      schemaVersion: 1, project: 'shop', environment: 'production', release: 'A', assetUrl,
      bundleSha256, mapSha256: 'a'.repeat(64),
    }), 'manifest.json');
    await expect(prepareSourceMap(manifest, tooLargeMap)).rejects.toMatchObject({ code: 'map-too-large' });
    expect(tooLargeMap.arrayBuffer).not.toHaveBeenCalled();
    const entry = await prepared();
    const full = { entries: new Map([[entry.key, { ...entry, byteLength: 32 * 1024 * 1024 }]]), conflicts: new Set<string>() };
    await expect(prepared('B')).resolves.toBeTruthy();
    expect(() => registerSourceMap(full, { ...entry, key: 'another' })).toThrowError(SourceMapInputError);
    const dense = await prepared('B', {
      version: 3, sources: ['src/b.ts'], names: [], mappings: 'AAAA,GAAO',
    });
    expect(dense.segmentCount).toBe(2);
    const segmentFull = {
      entries: new Map([[entry.key, { ...entry, segmentCount: 999_999 }]]), conflicts: new Set<string>(),
    };
    expect(() => registerSourceMap(segmentFull, dense)).toThrowError(SourceMapInputError);
    const cleared = removeSourceMap(segmentFull, entry.key);
    expect(registerSourceMap(cleared, dense).entries.get(dense.key)?.segmentCount).toBe(2);
  });

  it('rejects raw query or fragment frames to avoid matching ambiguous build bytes', async () => {
    const registry = registerSourceMap(emptySourceMaps(), await prepared());
    const raw = `at fn (${assetUrl}?v=1:2:3)`;
    expect(resolveStack(event(raw), registry)[0]).toMatchObject({ reason: 'invalid-frame' });
    expect(resolveStack(event(`at fn (${assetUrl}#frag:1:1)`), registry)[0].reason).toBe('invalid-frame');
  });

  it('treats a syntactically complete-looking final line at the SDK length limit as unverified', async () => {
    const registry = registerSourceMap(emptySourceMaps(), await prepared());
    const first = `at fn (${assetUrl}:1:1)\n`;
    const last = `at fn (${assetUrl}:1:1)`;
    const stack = first + 'x'.repeat(4096 - first.length - last.length - 1) + '\n' + last;
    expect(stack).toHaveLength(4096);
    const frames = resolveStack(event(stack), registry);
    expect(frames[0].original?.source).toBe('src/a.ts');
    expect(frames.at(-1)?.reason).toBe('invalid-frame');
  });

  it('retains bounded source content by source index and previews the mapped line on demand', async () => {
    const entry = await prepared('A', {
      version: 3, file: 'app.js', sources: ['src/same.ts', 'src/same.ts'],
      sourcesContent: ['wrong source', 'first\r\nconst 😀name = <img src=x onerror=alert(1)>;\r\nthird'],
      names: [], mappings: 'ACCG',
    });
    const registry = registerSourceMap(emptySourceMaps(), entry);
    const frame = resolveStack(event(`at fn (${assetUrl}:1:1)`), registry)[0];
    expect(frame.original).toEqual({ source: 'src/same.ts', line: 2, column: 4 });
    expect(frame.sourceReference).toEqual({ key: entry.key, index: 1 });
    expect(sourceExcerpt(frame, registry)).toEqual({
      status: 'available', lines: [
        { number: 1, before: 'first', after: '' },
        { number: 2, before: 'con', marked: 's', after: 't 😀name = <img src=x onerror=alert(1)>;' },
        { number: 3, before: 'third', after: '' },
      ],
    });
    expect(JSON.stringify(entry.trace)).not.toContain('wrong source');
    expect(JSON.stringify(entry.trace)).not.toContain('onerror');
  });

  it('keeps missing, invalid and oversized source contents from inventing a preview', async () => {
    const absent = await prepared();
    const missingRegistry = registerSourceMap(emptySourceMaps(), absent);
    expect(sourceExcerpt(resolveStack(event(`at fn (${assetUrl}:1:1)`), missingRegistry)[0], missingRegistry))
      .toEqual({ status: 'missing-source' });
    const oversized = await prepared('A', {
      version: 3, sources: ['src/a.ts'], sourcesContent: ['x'.repeat(512 * 1024 + 1)], names: [], mappings: 'AAAA',
    });
    expect(oversized.sourceContents?.size).toBe(0);
    const short = await prepared('A', {
      version: 3, sources: ['src/a.ts'], sourcesContent: ['short'], names: [], mappings: 'AAEA',
    });
    const shortRegistry = registerSourceMap(emptySourceMaps(), short);
    expect(sourceExcerpt(resolveStack(event(`at fn (${assetUrl}:1:1)`), shortRegistry)[0], shortRegistry))
      .toEqual({ status: 'missing-line' });
    const wide = await prepared('A', {
      version: 3, sources: ['src/a.ts'], sourcesContent: ['short'], names: [], mappings: 'AAAM',
    });
    const wideRegistry = registerSourceMap(emptySourceMaps(), wide);
    expect(sourceExcerpt(resolveStack(event(`at fn (${assetUrl}:1:1)`), wideRegistry)[0], wideRegistry))
      .toEqual({ status: 'missing-column' });
  });

  it('marks an emoji as a whole while preserving its UTF-16 source-map column', async () => {
    const entry = await prepared('A', {
      version: 3, sources: ['src/a.ts'], sourcesContent: ['😀 end'], names: [], mappings: 'AAAC',
    });
    const registry = registerSourceMap(emptySourceMaps(), entry);
    const frame = resolveStack(event(`at fn (${assetUrl}:1:1)`), registry)[0];
    expect(frame.original?.column).toBe(2);
    expect(sourceExcerpt(frame, registry)).toEqual({
      status: 'available', lines: [{ number: 1, before: '', marked: '😀', after: ' end' }],
    });
  });

  it('bounds long source lines while retaining the exact requested column', async () => {
    const entry = await prepared('A', {
      version: 3, sources: ['src/a.ts'], sourcesContent: [`${'a'.repeat(500)}X${'b'.repeat(500)}`],
      names: [], mappings: 'AAAA',
    });
    const registry = registerSourceMap(emptySourceMaps(), entry);
    const frame = resolveStack(event(`at fn (${assetUrl}:1:1)`), registry)[0];
    const excerpt = sourceExcerpt({ ...frame, original: { ...frame.original!, column: 501 } }, registry);
    expect(excerpt.status).toBe('available');
    if (excerpt.status !== 'available') return;
    expect(excerpt.lines[0].marked).toBe('X');
    expect(excerpt.lines[0].before).toMatch(/^…a+$/);
    expect(excerpt.lines[0].after).toMatch(/^b+…$/);
    expect(excerpt.lines[0].before.length + excerpt.lines[0].after.length).toBeLessThan(250);
  });

  it('maps V8, Firefox and WebKit React frames and retains name-only component frames', async () => {
    const a = await prepared('A', {
      version: 3, file: 'app.js', sources: ['src/A.tsx'], names: [], mappings: 'AAAA',
    });
    const b = await prepared('B', {
      version: 3, file: 'app.js', sources: ['src/B.tsx'], names: [], mappings: 'AAAA',
    });
    const registry = registerSourceMap(registerSourceMap(emptySourceMaps(), a), b);
    const componentStack = [
      `    at ProductSummary (${assetUrl}:1:1)`,
      `ProductPage@${assetUrl}:1:1`,
      `render@${assetUrl}:1:1`,
      '    at App',
      '    in Router (at Router.tsx:3:2)',
    ].join('\n');
    const frames = resolveComponentStack(event(undefined, 'B', { componentStack }), registry);
    expect(frames.map(frame => frame.name)).toEqual(['ProductSummary', 'ProductPage', 'render', 'App', 'Router']);
    expect(frames.slice(0, 3).map(frame => frame.original?.source)).toEqual(['src/B.tsx', 'src/B.tsx', 'src/B.tsx']);
    expect(frames.slice(3).map(frame => frame.reason)).toEqual(['no-location', 'no-location']);
    expect(frames[3]).toMatchObject({ raw: '    at App' });
    expect(resolveComponentStack(event(undefined, 'A', { componentStack }), registry)[0].original?.source).toBe('src/A.tsx');
    expect(generatedAssetUrls({ stack: `Error: x\n at run (${assetUrl}:1:1)`, componentStack }))
      .toEqual([assetUrl]);
    expect(generatedAssetUrls({ componentStack: '    at App' })).toEqual([]);
  });

  it('does not trust a final React frame at the SDK component-stack length limit', async () => {
    const registry = registerSourceMap(emptySourceMaps(), await prepared());
    const first = `    at App (${assetUrl}:1:1)\n`;
    const last = `    at App (${assetUrl}:1:1)`;
    const componentStack = first + 'x'.repeat(2048 - first.length - last.length - 1) + '\n' + last;
    expect(componentStack).toHaveLength(2048);
    const frames = resolveComponentStack(event(undefined, 'A', { componentStack }), registry);
    expect(frames[0].original?.source).toBe('src/a.ts');
    expect(frames.at(-1)?.reason).toBe('invalid-frame');
    expect(generatedAssetUrls({ componentStack })).toEqual([assetUrl]);
  });

  it('does not map credential-bearing URLs or merge duplicate component names', async () => {
    const registry = registerSourceMap(emptySourceMaps(), await prepared());
    const credentialFrame = '    at App (https://user:secret@example.test/assets/app.js:1:1)';
    const componentStack = `${credentialFrame}\n    at App\n    at App`;
    const frames = resolveComponentStack(event(undefined, 'A', { componentStack }), registry);
    expect(frames).toHaveLength(3);
    expect(frames.map(frame => frame.name)).toEqual(['App', 'App', 'App']);
    expect(frames.map(frame => frame.reason)).toEqual(['invalid-frame', 'no-location', 'no-location']);
    expect(frames.every(frame => !frame.original)).toBe(true);
    expect(generatedAssetUrls({ componentStack })).toEqual([]);
  });
});
