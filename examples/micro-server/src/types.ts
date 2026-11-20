import type { ErrorEventRecord, EventFilter, EventPage } from '@ihyeon/browser-error-log-protocol';
import type { SourceMapManifest } from '../../../apps/viewer/src/source-map-manifest.ts';

export type StorageMode = 'sqlite' | 'jsonl';
export interface WriteResult { accepted: number; stored: number; duplicates: number }
export interface StoredSourceMap { manifest: SourceMapManifest; mapBase64: string }
export type SourceMapRegistrationResult = 'created' | 'duplicate' | 'conflict' | 'full';
export interface MicroStorage {
  readonly mode: StorageMode;
  readonly queryable: boolean;
  readonly sourceMapRegistry?: boolean;
  writeBatch(events: ErrorEventRecord[]): Promise<WriteResult>;
  list(filter: EventFilter): EventPage;
  get(project: string, eventId: string): ErrorEventRecord | null;
  registerSourceMap?(manifest: SourceMapManifest, mapBytes: Buffer, segmentCount: number): SourceMapRegistrationResult;
  getSourceMap?(key: Pick<SourceMapManifest, 'project' | 'environment' | 'release' | 'assetUrl'>): StoredSourceMap | null;
  maintain(): Promise<void>;
  close(): Promise<void>;
}

export interface StorageOptions {
  dataDir: string;
  sourceMapToken?: string;
  retentionDays: number;
  maxEvents: number;
  maxDbBytes: number;
  logFileBytes: number;
  logFiles: number;
  now?: () => number;
}

export interface MicroConfig extends StorageOptions {
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  mode: StorageMode;
  projects: string[];
  allowedOrigins: string[];
  publicUrl?: string;
  viewerPassword?: string;
  sourceMapToken?: string;
  requestsPerMinute: number;
  publicDir: string;
}
