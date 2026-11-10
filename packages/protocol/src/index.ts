export const SCHEMA_VERSION = 1 as const;
export const SDK_VERSION = '0.2.5';

export type EventType = 'javascript' | 'promise' | 'react' | 'console' | 'http' | 'network' | 'resource' | 'manual';
export type Runtime = 'browser' | 'webview-ios' | 'webview-android' | 'unknown';

export const BREADCRUMB_LIMITS = {
  count: 20, bytes: 12_000, category: 40, message: 256,
  dataKeys: 6, dataKey: 80, dataString: 200,
} as const;

export interface Breadcrumb {
  occurredAt: string;
  category: string;
  message: string;
  data?: Record<string, string | number | boolean | null>;
}

/** Validates the bounded, canonical UTC breadcrumb representation on the wire. */
export function isBreadcrumbTrail(value: unknown): value is Breadcrumb[] {
  try {
    if (!Array.isArray(value) || value.length > BREADCRUMB_LIMITS.count) return false;
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      if (Object.keys(item).some(key => !['occurredAt', 'category', 'message', 'data'].includes(key))) return false;
      if (typeof item.occurredAt !== 'string' || !Number.isFinite(Date.parse(item.occurredAt)) ||
          new Date(item.occurredAt).toISOString() !== item.occurredAt) return false;
      if (typeof item.category !== 'string' || !item.category.trim() || item.category.length > BREADCRUMB_LIMITS.category ||
          typeof item.message !== 'string' || !item.message.trim() || item.message.length > BREADCRUMB_LIMITS.message) return false;
      if (item.data !== undefined) {
        if (!item.data || typeof item.data !== 'object' || Array.isArray(item.data)) return false;
        const entries = Object.entries(item.data);
        if (entries.length > BREADCRUMB_LIMITS.dataKeys || entries.some(([key, field]) =>
          key.length > BREADCRUMB_LIMITS.dataKey || !(field === null || typeof field === 'boolean' ||
            (typeof field === 'string' && field.length <= BREADCRUMB_LIMITS.dataString) ||
            (typeof field === 'number' && Number.isFinite(field))))) return false;
      }
    }
    return new TextEncoder().encode(JSON.stringify(value)).length <= BREADCRUMB_LIMITS.bytes;
  } catch { return false; }
}

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
  breadcrumbs?: Breadcrumb[];
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
  http: 'HTTP error', network: 'Network failure', resource: 'Resource failure', manual: 'Manual',
};
