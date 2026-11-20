import { TraceMap, decodedMappings, traceSegment } from '@jridgewell/trace-mapping';
import type { ErrorEventRecord } from '@ihyeon/browser-error-log-protocol';
import {
  MAX_MANIFEST_BYTES, MAX_MAP_BYTES, canonicalAssetUrl, matchesGeneratedFile, parseSourceMapManifest,
  type SourceMapManifest,
} from './source-map-manifest';

const MAX_REGISTRATIONS = 32;
const MAX_REGISTERED_BYTES = 32 * 1024 * 1024;
const MAX_REGISTERED_SEGMENTS = 1_000_000;
const MAX_MAPPING_LINES = 100_000;
const MAX_MAPPING_SEGMENTS = 300_000;
const MAX_SOURCES = 10_000;
const MAX_NAMES = 20_000;
const MAX_SOURCE_CONTENT_BYTES = 512 * 1024;
const MAX_RETAINED_SOURCE_BYTES = 4 * 1024 * 1024;
const SOURCE_CONTEXT_LINES = 2;
const MAX_PREVIEW_LINE_UNITS = 240;

export type SourceMapInputCode =
  | 'manifest-too-large' | 'invalid-manifest' | 'map-too-large'
  | 'map-hash-mismatch' | 'unsupported-map' | 'invalid-map'
  | 'registry-full' | 'crypto-unavailable';

export class SourceMapInputError extends Error {
  constructor(readonly code: SourceMapInputCode) {
    super(code);
    this.name = 'SourceMapInputError';
  }
}

export interface PreparedSourceMap {
  key: string;
  manifest: SourceMapManifest;
  mapSha256: string;
  bundleSha256: string;
  byteLength: number;
  segmentCount: number;
  trace: TraceMap;
  // Indexed by the original map source index. Never placed in TraceMap or fetched by URL.
  sourceContents?: ReadonlyMap<number, string>;
}

export interface MapRegistry {
  entries: ReadonlyMap<string, PreparedSourceMap>;
  conflicts: ReadonlySet<string>;
}

export type UnmappedReason =
  | 'no-stack' | 'unrecognized-frame' | 'unknown-release'
  | 'no-registration' | 'registration-conflict' | 'no-mapping' | 'invalid-frame' | 'no-location';

export interface ResolvedFrame {
  raw: string;
  name?: string;
  generated?: { url: string; line: number; column: number };
  original?: { source: string; line: number; column: number };
  sourceReference?: { key: string; index: number };
  reason?: UnmappedReason;
}

export type SourceExcerpt =
  | { status: 'missing-source' | 'missing-line' | 'missing-column' }
  | { status: 'available'; lines: { number: number; before: string; marked?: string; after: string }[] };

export function sourceMapKey(manifest: Pick<SourceMapManifest, 'project' | 'environment' | 'release' | 'assetUrl'>): string {
  return JSON.stringify([manifest.project, manifest.environment, manifest.release, manifest.assetUrl]);
}

export function emptySourceMaps(): MapRegistry {
  return { entries: new Map(), conflicts: new Set() };
}

function decodedText(bytes: ArrayBuffer, code: SourceMapInputCode): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SourceMapInputError(code);
  }
}

async function fileBytes(file: File, maximum: number, code: SourceMapInputCode): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maximum) throw new SourceMapInputError(code);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) throw new SourceMapInputError(code);
  return bytes;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new SourceMapInputError('crypto-unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function checkedMap(input: unknown, manifest: SourceMapManifest): {
  trace: TraceMap; segmentCount: number; sourceContents: ReadonlyMap<number, string>;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SourceMapInputError('invalid-map');
  const map = input as Record<string, unknown>;
  if (map.version !== 3 || 'sections' in map) throw new SourceMapInputError('unsupported-map');
  if (!Array.isArray(map.sources) || map.sources.length > MAX_SOURCES ||
      !map.sources.every(source => source === null || (typeof source === 'string' && source.length <= 2048)) ||
      (map.names !== undefined && (!Array.isArray(map.names) || map.names.length > MAX_NAMES ||
        !map.names.every(name => typeof name === 'string' && name.length <= 2048))) ||
      typeof map.mappings !== 'string' || !/^[A-Za-z0-9+/;,]*$/.test(map.mappings) ||
      (map.sourceRoot !== undefined && (typeof map.sourceRoot !== 'string' || map.sourceRoot.length > 2048)) ||
      (map.file !== undefined && map.file !== null && typeof map.file !== 'string')) {
    throw new SourceMapInputError('invalid-map');
  }
  if (!matchesGeneratedFile(map.file, manifest.assetUrl)) {
    throw new SourceMapInputError('invalid-map');
  }
  validateMappingsEncoding(map.mappings);
  try {
    // Retain only safe relative root segments needed to distinguish author files.
    // The original root and source contents never enter TraceMap.
    const root = typeof map.sourceRoot === 'string' ? map.sourceRoot.replaceAll('\\', '/') : '';
    const safeRoot = root && !root.startsWith('/') && !root.includes('..') &&
      !/[:?#\u0000-\u001f\u007f]/u.test(root) ? root.replace(/\/+$/, '') : '';
    const sources = (map.sources as (string | null)[]).map(source => {
      if (!source) return null;
      const normalizedSource = source.replaceAll('\\', '/');
      const rooted = safeRoot && !normalizedSource.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(source) &&
        !normalizedSource.split('/').includes('..') ? `${safeRoot}/${source}` : source;
      return displaySourcePath(rooted);
    });
    const trace = new TraceMap({
      version: 3,
      sources,
      names: Array((map.names as string[] | undefined)?.length ?? 0).fill(''),
      mappings: map.mappings,
    });
    const sourceContents = new Map<number, string>();
    const contents = map.sourcesContent;
    if (Array.isArray(contents) && contents.length === sources.length) {
      let retainedBytes = 0;
      for (let index = 0; index < contents.length; index++) {
        const content = contents[index];
        if (!sources[index] || typeof content !== 'string') continue;
        const bytes = new TextEncoder().encode(content).byteLength;
        if (bytes > MAX_SOURCE_CONTENT_BYTES || retainedBytes + bytes > MAX_RETAINED_SOURCE_BYTES) continue;
        sourceContents.set(index, content);
        retainedBytes += bytes;
      }
    }
    let count = 0;
    for (const line of decodedMappings(trace)) {
      let lastColumn = -1;
      for (const segment of line) {
        count++;
        if (count > MAX_MAPPING_SEGMENTS || ![1, 4, 5].includes(segment.length) ||
            segment.some(value => !Number.isSafeInteger(value) || value < 0) || segment[0] <= lastColumn ||
            (segment.length > 1 && segment[1]! >= map.sources.length) ||
            (segment.length === 5 && segment[4]! >= trace.names.length)) {
          throw new SourceMapInputError('invalid-map');
        }
        lastColumn = segment[0];
      }
    }
    return { trace, segmentCount: count, sourceContents };
  } catch {
    throw new SourceMapInputError('invalid-map');
  }
}

function validateMappingsEncoding(mappings: string): void {
  let lines = 1;
  let segments = 0;
  let fields = 0;
  let digits = 0;
  let started = false;
  let afterComma = false;
  for (const character of mappings) {
    if (character === ',' || character === ';') {
      if (digits || afterComma || (started && ![1, 4, 5].includes(fields)) || (character === ',' && !started)) {
        throw new SourceMapInputError('invalid-map');
      }
      if (started) segments++;
      if (character === ';') lines++;
      afterComma = character === ',';
      started = false;
      fields = 0;
      digits = 0;
    } else {
      const code = character.charCodeAt(0);
      const value = code >= 65 && code <= 90 ? code - 65
        : code >= 97 && code <= 122 ? code - 97 + 26
          : code >= 48 && code <= 57 ? code - 48 + 52
            : code === 43 ? 62 : code === 47 ? 63 : -1;
      digits++;
      if (value < 0 || digits > 7 || (digits === 7 && value > 3)) throw new SourceMapInputError('invalid-map');
      started = true;
      afterComma = false;
      if (value < 32) {
        fields++;
        digits = 0;
      }
    }
    if (lines > MAX_MAPPING_LINES || segments > MAX_MAPPING_SEGMENTS) throw new SourceMapInputError('invalid-map');
  }
  if (digits || afterComma || (started && ![1, 4, 5].includes(fields)) ||
      segments + Number(started) > MAX_MAPPING_SEGMENTS) throw new SourceMapInputError('invalid-map');
}

export async function prepareSourceMap(manifestFile: File, mapFile: File): Promise<PreparedSourceMap> {
  const manifestBytes = await fileBytes(manifestFile, MAX_MANIFEST_BYTES, 'manifest-too-large');
  let manifest: SourceMapManifest;
  try {
    manifest = parseSourceMapManifest(JSON.parse(decodedText(manifestBytes, 'invalid-manifest')));
  } catch {
    throw new SourceMapInputError('invalid-manifest');
  }
  const mapBytes = await fileBytes(mapFile, MAX_MAP_BYTES, 'map-too-large');
  const digest = await sha256(mapBytes);
  if (digest !== manifest.mapSha256) throw new SourceMapInputError('map-hash-mismatch');
  let map: unknown;
  try {
    map = JSON.parse(decodedText(mapBytes, 'invalid-map'));
  } catch {
    throw new SourceMapInputError('invalid-map');
  }
  const { trace, segmentCount, sourceContents } = checkedMap(map, manifest);
  return {
    key: sourceMapKey(manifest), manifest,
    mapSha256: digest, bundleSha256: manifest.bundleSha256,
    byteLength: mapBytes.byteLength, segmentCount, trace, sourceContents,
  };
}

export function registerSourceMap(current: MapRegistry, prepared: PreparedSourceMap): MapRegistry {
  const prior = current.entries.get(prepared.key);
  if (current.conflicts.has(prepared.key)) return current;
  if (prior) {
    if (prior.mapSha256 === prepared.mapSha256 && prior.bundleSha256 === prepared.bundleSha256) return current;
    return { entries: current.entries, conflicts: new Set([...current.conflicts, prepared.key]) };
  }
  const totalBytes = [...current.entries.values()].reduce((sum, entry) => sum + entry.byteLength, 0);
  const totalSegments = [...current.entries.values()].reduce((sum, entry) => sum + entry.segmentCount, 0);
  if (current.entries.size >= MAX_REGISTRATIONS || totalBytes + prepared.byteLength > MAX_REGISTERED_BYTES ||
      totalSegments + prepared.segmentCount > MAX_REGISTERED_SEGMENTS) {
    throw new SourceMapInputError('registry-full');
  }
  return { entries: new Map([...current.entries, [prepared.key, prepared]]), conflicts: current.conflicts };
}

export function removeSourceMap(current: MapRegistry, key: string): MapRegistry {
  if (!current.entries.has(key) && !current.conflicts.has(key)) return current;
  const entries = new Map(current.entries);
  const conflicts = new Set(current.conflicts);
  entries.delete(key);
  conflicts.delete(key);
  return { entries, conflicts };
}

function displaySourcePath(input: string | null): string | null {
  if (!input) return null;
  const normalized = input.replaceAll('\\', '/');
  const drive = /^[A-Za-z]:\//.test(normalized);
  const scheme = /^[A-Za-z][A-Za-z\d+.-]*:/.exec(normalized)?.[0];
  if (scheme && !drive && !normalized.startsWith(`${scheme}//`)) return null;
  const unc = !scheme && normalized.startsWith('//');
  const authority = scheme && !drive ? `${scheme}//` : normalized.startsWith('//') ? '//' : '';
  const absolute = Boolean(authority || drive || normalized.startsWith('/'));
  const pathname = authority ? normalized.slice(authority.length).replace(/^[^/]*/, '')
    : drive ? normalized.slice(2) : normalized;
  // UNC paths start with both a server and a share; neither is an author file.
  const path = (unc ? pathname.replace(/^\/[^/]*(?=\/|$)/, '') : pathname).split(/[?#]/, 1)[0];
  if (!path || path.endsWith('/')) return null;
  const parts = path.split('/').filter(part => part && part !== '.' && part !== '..');
  const traversing = path.split('/').includes('..');
  const sourceIndex = parts.findIndex(part => ['src', 'features', 'components', 'pages', ...(absolute ? [] : ['app'])].includes(part));
  const safeParts = sourceIndex >= 0 ? parts.slice(sourceIndex) : absolute || traversing ? parts.slice(-1) : parts;
  if (!safeParts.length || safeParts.some(part => /[\u0000-\u001f\u007f]/u.test(part))) return null;
  const safe = safeParts.join('/');
  return safe.length <= 240 ? safe : safeParts.at(-1)!.slice(-240);
}

function parseFrame(raw: string): ResolvedFrame {
  const v8 = /^\s*at\s+(?:[^()\n]*\()?((?:https?):\/\/[^\s()]+):([1-9]\d*):([1-9]\d*)\)?\s*$/.exec(raw);
  const gecko = /^(?:[^@\n]*@)?((?:https?):\/\/\S+):([1-9]\d*):([1-9]\d*)\s*$/.exec(raw);
  const match = v8 ?? gecko;
  if (!match) return { raw, reason: /https?:\/\//.test(raw) ? 'invalid-frame' : 'unrecognized-frame' };
  const [, asset, rawLine, rawColumn] = match;
  const line = Number(rawLine);
  const column = Number(rawColumn);
  const url = canonicalAssetUrl(asset);
  if (!url || !Number.isSafeInteger(line) || !Number.isSafeInteger(column) ||
      /[?#]/.test(asset)) return { raw, reason: 'invalid-frame' };
  return { raw, generated: { url, line, column } };
}

function parseComponentFrame(raw: string): ResolvedFrame {
  const frame = parseFrame(raw);
  const v8Name = /^\s*at\s+(.+?)\s*\(/u.exec(raw)?.[1] ?? /^\s*at\s+(\S+)\s*$/u.exec(raw)?.[1];
  const geckoName = /^([^@\n]+)@https?:\/\//u.exec(raw)?.[1];
  const reactName = /^\s*in\s+(.+?)(?:\s+\(|\s*$)/u.exec(raw)?.[1];
  const name = (v8Name ?? geckoName ?? reactName)?.trim();
  return {
    ...frame,
    ...(name ? { name: name.slice(0, 240) } : {}),
    ...(!frame.generated && frame.reason === 'unrecognized-frame' ? { reason: 'no-location' as const } : {}),
  };
}

function stackLines(stack: string, sdkLimit = 4096): { lines: string[]; tailMayBePartial: boolean } {
  const clipped = stack.slice(0, 16 * 1024);
  const allLines = clipped.split('\n');
  return {
    lines: allLines.slice(0, 100),
    tailMayBePartial: stack.length >= sdkLimit && !clipped.endsWith('\n') && allLines.length <= 100,
  };
}

function resolveFrame(
  frame: ResolvedFrame,
  event: Pick<ErrorEventRecord, 'project' | 'environment' | 'release'>,
  registry: MapRegistry,
): ResolvedFrame {
  if (!frame.generated) return frame;
  if (!event.release || event.release === 'unknown') return { ...frame, reason: 'unknown-release' };
  const key = sourceMapKey({ ...event, assetUrl: frame.generated.url });
  if (registry.conflicts.has(key)) return { ...frame, reason: 'registration-conflict' };
  const registration = registry.entries.get(key);
  if (!registration) return { ...frame, reason: 'no-registration' };
  const segment = traceSegment(registration.trace, frame.generated.line - 1, frame.generated.column - 1);
  if (!segment || segment.length === 1) return { ...frame, reason: 'no-mapping' };
  const source = registration.trace.sources[segment[1]];
  if (!source) return { ...frame, reason: 'no-mapping' };
  return {
    ...frame,
    original: { source, line: segment[2] + 1, column: segment[3] + 1 },
    sourceReference: { key, index: segment[1] },
  };
}

export function resolveStack(
  event: Pick<ErrorEventRecord, 'project' | 'environment' | 'release' | 'stack'>,
  registry: MapRegistry,
): ResolvedFrame[] {
  if (!event.stack) return [{ raw: '', reason: 'no-stack' }];
  const { lines, tailMayBePartial } = stackLines(event.stack);
  const frames = lines.map(parseFrame);
  const hasLocation = frames.some(frame => frame.generated);
  return frames.map((frame, index): ResolvedFrame | null => {
    if (!frame.raw.trim() || (index === 0 && hasLocation && /^[\w.$]*(?:Error|Exception):/u.test(frame.raw))) return null;
    if (tailMayBePartial && index === frames.length - 1) return { raw: frame.raw, reason: 'invalid-frame' };
    return resolveFrame(frame, event, registry);
  }).filter((frame): frame is ResolvedFrame => frame !== null);
}

export function resolveComponentStack(
  event: Pick<ErrorEventRecord, 'project' | 'environment' | 'release' | 'componentStack'>,
  registry: MapRegistry,
): ResolvedFrame[] {
  if (!event.componentStack) return [];
  const { lines, tailMayBePartial } = stackLines(event.componentStack, 2048);
  const frames = lines.map(parseComponentFrame);
  return frames.map((frame, index): ResolvedFrame | null => {
    if (!frame.raw.trim()) return null;
    if (tailMayBePartial && index === frames.length - 1) return { raw: frame.raw, name: frame.name, reason: 'invalid-frame' };
    return resolveFrame(frame, event, registry);
  }).filter((frame): frame is ResolvedFrame => frame !== null);
}

export function generatedAssetUrls(event: Pick<ErrorEventRecord, 'stack' | 'componentStack'>): string[] {
  const urls = new Set<string>();
  for (const [stack, parser] of [
    [event.stack, parseFrame], [event.componentStack, parseComponentFrame],
  ] as const) {
    if (!stack) continue;
    const { lines, tailMayBePartial } = stackLines(stack, parser === parseComponentFrame ? 2048 : 4096);
    for (const [index, raw] of lines.entries()) {
      if (tailMayBePartial && index === lines.length - 1) continue;
      const url = parser(raw).generated?.url;
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

export function sourceExcerpt(frame: ResolvedFrame, registry: MapRegistry): SourceExcerpt {
  if (!frame.original || !frame.sourceReference || registry.conflicts.has(frame.sourceReference.key)) {
    return { status: 'missing-source' };
  }
  const content = registry.entries.get(frame.sourceReference.key)?.sourceContents?.get(frame.sourceReference.index);
  if (content === undefined) return { status: 'missing-source' };
  const lines = content.split(/\r\n|\n|\r/u);
  const target = lines[frame.original.line - 1];
  if (target === undefined) return { status: 'missing-line' };
  if (frame.original.column > target.length + 1) return { status: 'missing-column' };
  const start = Math.max(1, frame.original.line - SOURCE_CONTEXT_LINES);
  const end = Math.min(lines.length, frame.original.line + SOURCE_CONTEXT_LINES);
  const excerpt = [];
  for (let number = start; number <= end; number++) {
    const line = lines[number - 1];
    if (number !== frame.original.line) {
      excerpt.push({ number, before: line.length > MAX_PREVIEW_LINE_UNITS ? `${line.slice(0, MAX_PREVIEW_LINE_UNITS)}…` : line, after: '' });
      continue;
    }
    const index = frame.original.column - 1;
    const isLowSurrogate = index > 0 && /[\uDC00-\uDFFF]/u.test(line[index] ?? '') &&
      /[\uD800-\uDBFF]/u.test(line[index - 1] ?? '');
    const markStart = isLowSurrogate ? index - 1 : index;
    const isHighSurrogate = /[\uD800-\uDBFF]/u.test(line[markStart] ?? '') &&
      /[\uDC00-\uDFFF]/u.test(line[markStart + 1] ?? '');
    const markEnd = Math.min(line.length, markStart + (isHighSurrogate ? 2 : 1));
    const left = Math.max(0, markStart - Math.floor(MAX_PREVIEW_LINE_UNITS / 2));
    const right = Math.min(line.length, markEnd + Math.floor(MAX_PREVIEW_LINE_UNITS / 2));
    excerpt.push({
      number,
      before: `${left ? '…' : ''}${line.slice(left, markStart)}`,
      marked: line.slice(markStart, markEnd) || '│',
      after: `${line.slice(markEnd, right)}${right < line.length ? '…' : ''}`,
    });
  }
  return { status: 'available', lines: excerpt };
}
