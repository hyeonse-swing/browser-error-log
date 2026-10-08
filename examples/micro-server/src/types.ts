import type { ErrorEventRecord, EventFilter, EventPage } from 'browser-error-log-protocol';

export type StorageMode = 'sqlite' | 'jsonl';
export interface WriteResult { accepted: number; stored: number; duplicates: number }
export interface MicroStorage {
  readonly mode: StorageMode;
  readonly queryable: boolean;
  writeBatch(events: ErrorEventRecord[]): Promise<WriteResult>;
  list(filter: EventFilter): EventPage;
  get(project: string, eventId: string): ErrorEventRecord | null;
  maintain(): Promise<void>;
  close(): Promise<void>;
}

export interface StorageOptions {
  dataDir: string;
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
  requestsPerMinute: number;
  publicDir: string;
}
