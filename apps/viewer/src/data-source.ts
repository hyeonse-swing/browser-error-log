import type { ErrorEventRecord, EventDataSource, EventFilter, EventPage } from 'browser-error-log-protocol';

declare global {
  interface Window {
    __ERROR_LOG_VIEWER_CONFIG__?: {
      apiBase?: string;
      mode?: 'local' | 'live';
      title?: string;
    };
  }
}

export const viewerConfig = window.__ERROR_LOG_VIEWER_CONFIG__ ?? {};
const apiBase = (viewerConfig.apiBase ?? '/api').replace(/\/$/, '');

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Request failed. (HTTP ${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const eventDataSource: EventDataSource = {
  async listEvents(filter: EventFilter, signal?: AbortSignal): Promise<EventPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const query = params.toString();
    const response = await fetch(`${apiBase}/events${query ? `?${query}` : ''}`, { signal });
    return readResponse<EventPage>(response);
  },
  async getEvent(project: string, eventId: string, signal?: AbortSignal): Promise<ErrorEventRecord | null> {
    const params = new URLSearchParams({ project });
    const response = await fetch(`${apiBase}/events/${encodeURIComponent(eventId)}?${params}`, { signal });
    if (response.status === 404) return null;
    return readResponse<ErrorEventRecord>(response);
  },
};
