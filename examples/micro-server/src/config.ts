import { resolve } from 'node:path';
import type { MicroConfig, StorageMode } from './types.ts';

const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function integer(value: string | undefined, name: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || value.length > 10) throw new Error(`${name} must be an integer from 1 to ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
  return parsed;
}

function path(value: string | undefined, name: string, fallback: string): string {
  const selected = value === undefined ? fallback : value;
  if (!selected || selected.length > 1024 || selected.includes('\0')) throw new Error(`${name} must be a nonempty path`);
  return resolve(selected);
}

function exactOrigin(value: string, name: string): string {
  if (!value || value.length > 2048 || value === 'null' || value.includes('*')) throw new Error(`${name} must contain exact http/https origins`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must contain exact http/https origins`); }
  if (!['http:', 'https:'].includes(url.protocol) || value !== url.origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must contain exact http/https origins`);
  }
  return value;
}

function projects(value: string | undefined): string[] {
  const list = (value === undefined ? 'my-web' : value).split(',');
  if (list.length > 32 || list.some(item => !PROJECT_ID.test(item)) || new Set(list).size !== list.length) {
    throw new Error('MICRO_PROJECTS must contain 1 to 32 distinct project IDs');
  }
  return list;
}

function origins(value: string | undefined): string[] {
  if (value === undefined) return [];
  const list = value.split(',');
  if (list.length > 32) throw new Error('MICRO_ALLOWED_ORIGINS accepts at most 32 origins');
  const parsed = list.map(origin => exactOrigin(origin, 'MICRO_ALLOWED_ORIGINS'));
  if (new Set(parsed).size !== parsed.length) throw new Error('MICRO_ALLOWED_ORIGINS must not repeat origins');
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): MicroConfig {
  const host = env.MICRO_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('MICRO_HOST must be 127.0.0.1 or 0.0.0.0');
  const mode = env.MICRO_STORAGE ?? 'sqlite';
  if (mode !== 'sqlite' && mode !== 'jsonl') throw new Error('MICRO_STORAGE must be sqlite or jsonl');
  const projectIds = projects(env.MICRO_PROJECTS);
  const allowedOrigins = origins(env.MICRO_ALLOWED_ORIGINS);
  const publicUrl = env.MICRO_PUBLIC_URL === undefined ? undefined : exactOrigin(env.MICRO_PUBLIC_URL, 'MICRO_PUBLIC_URL');
  const viewerPassword = env.MICRO_VIEWER_PASSWORD;
  if (viewerPassword !== undefined && (!viewerPassword || viewerPassword.length > 256 || /[\x00-\x1f\x7f]/.test(viewerPassword))) {
    throw new Error('MICRO_VIEWER_PASSWORD must be 1 to 256 printable characters');
  }
  // A loopback listener behind a reverse proxy is public too when a public URL is configured.
  if (host === '0.0.0.0' || publicUrl !== undefined) {
    if (!publicUrl?.startsWith('https://')) throw new Error('MICRO_PUBLIC_URL must be an HTTPS origin for external binding');
    if (!viewerPassword || viewerPassword.length < 16) throw new Error('MICRO_VIEWER_PASSWORD must have at least 16 characters for external binding');
    if (env.MICRO_PROJECTS === undefined || env.MICRO_ALLOWED_ORIGINS === undefined || allowedOrigins.length === 0) {
      throw new Error('External binding requires explicit MICRO_PROJECTS and MICRO_ALLOWED_ORIGINS');
    }
  }
  return {
    host,
    port: integer(env.MICRO_PORT, 'MICRO_PORT', 4319, 65535),
    mode: mode as StorageMode,
    dataDir: path(env.MICRO_DATA_DIR, 'MICRO_DATA_DIR', '.data/micro-server'),
    publicDir: path(env.MICRO_PUBLIC_DIR, 'MICRO_PUBLIC_DIR', 'dist/micro-server/public'),
    projects: projectIds,
    allowedOrigins,
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(viewerPassword === undefined ? {} : { viewerPassword }),
    retentionDays: integer(env.MICRO_RETENTION_DAYS, 'MICRO_RETENTION_DAYS', 7, 365),
    maxEvents: integer(env.MICRO_MAX_EVENTS, 'MICRO_MAX_EVENTS', 10_000, 1_000_000),
    maxDbBytes: integer(env.MICRO_MAX_DB_MB, 'MICRO_MAX_DB_MB', 64, 1024) * 1024 * 1024,
    logFileBytes: integer(env.MICRO_LOG_FILE_MB, 'MICRO_LOG_FILE_MB', 8, 128) * 1024 * 1024,
    logFiles: integer(env.MICRO_LOG_FILES, 'MICRO_LOG_FILES', 3, 20),
    requestsPerMinute: integer(env.MICRO_REQUESTS_PER_MINUTE, 'MICRO_REQUESTS_PER_MINUTE', 120, 10_000),
  };
}
