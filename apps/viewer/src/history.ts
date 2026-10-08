import type { ErrorEventRecord, EventDataSource, EventFilter, EventPage, EventType, Runtime } from 'browser-error-log-protocol';

export const MAX_HISTORY_EVENTS = 10_000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const eventTypes = new Set<EventType>(['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual']);
const runtimes = new Set<Runtime>(['browser', 'webview-ios', 'webview-android', 'unknown']);
const isoDate = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

export type HistoryResult = { events: ErrorEventRecord[]; truncated: boolean; duplicates: number };

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, nonEmpty = false): string {
  if (typeof value !== 'string' || (nonEmpty && !value)) {
    throw new Error(`${label} must be ${nonEmpty ? 'a non-empty' : 'a'} string.`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const input = string(value, label);
  const match = isoDate.exec(input);
  if (!match) throw new Error(`${label} must be an ISO date with a timezone.`);
  const [, year, month, day, hour, minute, second, fraction = '', zone, sign, offsetHour, offsetMinute] = match;
  const y = Number(year), mo = Number(month), d = Number(day);
  const h = Number(hour), mi = Number(minute), s = Number(second);
  const oh = Number(offsetHour ?? 0), om = Number(offsetMinute ?? 0);
  const days = new Date(0);
  days.setUTCFullYear(y, mo, 0);
  if (mo < 1 || mo > 12 || d < 1 || d > days.getUTCDate() || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59) {
    throw new Error(`${label} has an invalid date or timezone.`);
  }
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) throw new Error(`${label} has an invalid date.`);
  const offset = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (oh * 60 + om);
  const local = new Date(parsed + offset * 60_000);
  const ms = Number((fraction + '000').slice(0, 3));
  if (local.getUTCFullYear() !== y || local.getUTCMonth() + 1 !== mo || local.getUTCDate() !== d ||
      local.getUTCHours() !== h || local.getUTCMinutes() !== mi || local.getUTCSeconds() !== s ||
      local.getUTCMilliseconds() !== ms) {
    throw new Error(`${label} has an invalid date.`);
  }
  return new Date(parsed).toISOString();
}

function optionalString(source: Record<string, unknown>, key: string, label: string): string | undefined {
  return source[key] === undefined ? undefined : string(source[key], `${label}.${key}`);
}

function projectEvent(value: unknown, label: string): ErrorEventRecord {
  const raw = record(value, label);
  if (raw.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1.`);
  if (!eventTypes.has(raw.type as EventType)) throw new Error(`${label}.type is invalid.`);
  if (!runtimes.has(raw.runtime as Runtime)) throw new Error(`${label}.runtime is invalid.`);
  const sequence = number(raw.sequence, `${label}.sequence`);
  const elapsedMs = number(raw.elapsedMs, `${label}.elapsedMs`);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error(`${label}.sequence must be a non-negative integer.`);
  if (elapsedMs < 0) throw new Error(`${label}.elapsedMs must be non-negative.`);

  const event: ErrorEventRecord = {
    schemaVersion: 1,
    eventId: string(raw.eventId, `${label}.eventId`, true),
    project: string(raw.project, `${label}.project`, true),
    environment: string(raw.environment, `${label}.environment`),
    release: string(raw.release, `${label}.release`),
    sdkVersion: string(raw.sdkVersion, `${label}.sdkVersion`),
    occurredAt: timestamp(raw.occurredAt, `${label}.occurredAt`),
    viewId: string(raw.viewId, `${label}.viewId`),
    sequence,
    elapsedMs,
    type: raw.type as EventType,
    message: string(raw.message, `${label}.message`),
    page: string(raw.page, `${label}.page`),
    runtime: raw.runtime as Runtime,
  };
  if (raw.receivedAt !== undefined) event.receivedAt = timestamp(raw.receivedAt, `${label}.receivedAt`);
  for (const key of ['name', 'stack', 'componentStack', 'browser'] as const) {
    const value = optionalString(raw, key, label);
    if (value !== undefined) event[key] = value;
  }
  if (raw.context !== undefined) {
    const context = record(raw.context, `${label}.context`);
    const entries = Object.entries(context).map(([key, value]) => {
      if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' &&
          !(typeof value === 'number' && Number.isFinite(value))) {
        throw new Error(`${label}.context.${key} must be a string, finite number, boolean, or null.`);
      }
      return [key, value] as const;
    });
    event.context = Object.fromEntries(entries);
  }
  if (raw.network !== undefined) {
    const network = record(raw.network, `${label}.network`);
    const durationMs = number(network.durationMs, `${label}.network.durationMs`);
    if (durationMs < 0) throw new Error(`${label}.network.durationMs must be non-negative.`);
    const projected: NonNullable<ErrorEventRecord['network']> = {
      method: string(network.method, `${label}.network.method`),
      url: string(network.url, `${label}.network.url`),
      durationMs,
    };
    if (network.status !== undefined) {
      const status = number(network.status, `${label}.network.status`);
      if (!Number.isInteger(status) || status < 0 || status > 599) {
        throw new Error(`${label}.network.status must be an integer from 0 to 599.`);
      }
      projected.status = status;
    }
    event.network = projected;
  }
  return event;
}

function newestFirst(events: ErrorEventRecord[]): ErrorEventRecord[] {
  return events.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
    b.eventId.localeCompare(a.eventId) || b.project.localeCompare(a.project));
}

function key(event: ErrorEventRecord): string {
  return JSON.stringify([event.project, event.eventId]);
}

function abortError(): DOMException {
  return new DOMException('History request was aborted.', 'AbortError');
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function requestPage(source: EventDataSource, filter: EventFilter, signal: AbortSignal): Promise<EventPage> {
  checkAbort(signal);
  return new Promise<EventPage>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    try {
      Promise.resolve(source.listEvents(filter, signal)).then(
        page => { cleanup(); signal.aborted ? reject(abortError()) : resolve(page); },
        error => { cleanup(); reject(signal.aborted ? abortError() : error); },
      );
    } catch (error) {
      cleanup();
      reject(signal.aborted ? abortError() : error);
    }
  });
}

export async function loadHistory(
  source: EventDataSource,
  filter: EventFilter,
  signal: AbortSignal,
  onProgress?: (count: number) => void,
): Promise<HistoryResult> {
  const fixedFilter = { ...filter };
  delete fixedFilter.cursor;
  delete fixedFilter.limit;
  const events: ErrorEventRecord[] = [];
  const seenEvents = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let duplicates = 0;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const page = await requestPage(source, { ...fixedFilter, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, signal);
    checkAbort(signal);
    const raw = record(page, `History page ${pageNumber}`);
    if (!Array.isArray(raw.events) || raw.events.length > PAGE_SIZE) {
      throw new Error(`History ${pageNumber} page has an invalid event list.`);
    }
    if (raw.nextCursor !== undefined && (typeof raw.nextCursor !== 'string' || !raw.nextCursor)) {
      throw new Error(`History ${pageNumber} page has an invalid next cursor.`);
    }
    if (raw.nextCursor && raw.events.length === 0) {
      throw new Error(`History ${pageNumber} page is empty but returned a next cursor.`);
    }
    for (let index = 0; index < raw.events.length; index++) {
      const event = projectEvent(raw.events[index], `History ${pageNumber} event ${index + 1}`);
      const eventKey = key(event);
      if (seenEvents.has(eventKey)) { duplicates++; continue; }
      seenEvents.add(eventKey);
      events.push(event);
    }
    checkAbort(signal);
    onProgress?.(events.length);
    checkAbort(signal);
    if (!raw.nextCursor) return { events: newestFirst(events), truncated: false, duplicates };
    if (seenCursors.has(raw.nextCursor)) throw new Error(`History ${pageNumber} page repeated a cursor.`);
    seenCursors.add(raw.nextCursor);
    cursor = raw.nextCursor;
    if (events.length >= MAX_HISTORY_EVENTS || pageNumber === MAX_PAGES) {
      return { events: newestFirst(events), truncated: true, duplicates };
    }
  }
  throw new Error('Could not verify the history page limit.');
}

function deduplicate(events: unknown[], label: string): HistoryResult {
  if (events.length > MAX_HISTORY_EVENTS) throw new Error(`You can import up to ${MAX_HISTORY_EVENTS.toLocaleString('en-US')} events.`);
  const unique: ErrorEventRecord[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (let index = 0; index < events.length; index++) {
    const event = projectEvent(events[index], `${label} ${index + 1}`);
    const eventKey = key(event);
    if (seen.has(eventKey)) { duplicates++; continue; }
    seen.add(eventKey);
    unique.push(event);
  }
  return { events: newestFirst(unique), truncated: false, duplicates };
}

function checkBytes(text: string): void {
  if (text.length > MAX_IMPORT_BYTES || new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('Import files cannot exceed 10 MiB.');
  }
}

export function parseHistoryJson(text: string): HistoryResult {
  checkBytes(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('This is not a valid JSON file.'); }
  let events: unknown;
  let partial = false;
  if (Array.isArray(parsed)) events = parsed;
  else {
    const envelope = record(parsed, 'Import file');
    if (envelope.schemaVersion !== 1) throw new Error('Unsupported history file version. schemaVersion 1 is required.');
    if (envelope.partial !== undefined && typeof envelope.partial !== 'boolean') {
      throw new Error('Import file.partial must be a boolean.');
    }
    partial = envelope.partial === true;
    events = envelope.events;
  }
  if (!Array.isArray(events)) throw new Error('Import file has no events array.');
  return { ...deduplicate(events, 'Imported event'), truncated: partial };
}

export function serializeHistory(events: ErrorEventRecord[], options?: { truncated?: boolean }): string {
  const normalized = deduplicate(events, 'Exported event');
  const text = JSON.stringify({ schemaVersion: 1, ...(options?.truncated ? { partial: true } : {}), events: normalized.events });
  checkBytes(text);
  return text;
}

export function filterHistory(events: ErrorEventRecord[], filter: EventFilter): ErrorEventRecord[] {
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('History filter has an invalid date.');
  const query = (filter.query ?? '').toLocaleLowerCase();
  return newestFirst(events.filter(event => {
    const at = Date.parse(event.occurredAt);
    return Number.isFinite(at) && at >= from && at <= to &&
      (!filter.project || event.project === filter.project) &&
      (!filter.environment || event.environment === filter.environment) &&
      (!filter.type || event.type === filter.type) &&
      (!query || `${event.message} ${event.page} ${event.eventId} ${event.release} ${event.network?.url ?? ''}`.toLocaleLowerCase().includes(query));
  }));
}
