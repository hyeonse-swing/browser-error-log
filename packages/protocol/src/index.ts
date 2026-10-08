export const SCHEMA_VERSION = 1 as const;
export const SDK_VERSION = '0.1.0';

export type EventType = 'javascript' | 'promise' | 'react' | 'console' | 'http' | 'network' | 'manual';
export type Runtime = 'browser' | 'webview-ios' | 'webview-android' | 'unknown';
export interface ErrorEventRecord {
  schemaVersion: 1;
  eventId: string;
  project: string;
  environment: string;
  release: string;
  sdkVersion: string;
  occurredAt: string;
  receivedAt?: string;
  viewId: string;
  sequence: number;
  elapsedMs: number;
  type: EventType;
  message: string;
  name?: string;
  stack?: string;
  componentStack?: string;
  page: string;
  runtime: Runtime;
  browser?: string;
  context?: Record<string, string | number | boolean | null>;
  network?: { method: string; url: string; status?: number; durationMs: number };
}

export interface EventBatch { schemaVersion: 1; events: ErrorEventRecord[] }
export interface EventFilter {
  project?: string;
  environment?: string;
  type?: EventType;
  query?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export interface EventPage { events: ErrorEventRecord[]; nextCursor?: string }
export interface EventDataSource {
  listEvents(filter: EventFilter, signal?: AbortSignal): Promise<EventPage>;
  getEvent(project: string, eventId: string, signal?: AbortSignal): Promise<ErrorEventRecord | null>;
}

export const EVENT_LABELS: Record<EventType, string> = {
  javascript: 'JavaScript', promise: 'Promise', react: 'React', console: 'Console',
  http: 'HTTP error', network: 'Network failure', manual: 'Manual',
};
