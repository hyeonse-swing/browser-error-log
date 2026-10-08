import { EVENT_LABELS, type ErrorEventRecord, type EventType } from 'browser-error-log-protocol';

export type Breakdown = { key: string; label: string; count: number };
export type TrendBucket = { from: number; to: number; count: number; types: Record<EventType, number> };
export type TopError = {
  key: string;
  message: string;
  project: string;
  type: EventType;
  count: number;
  lastOccurredAt: string;
  event: ErrorEventRecord;
};
export type Analytics = {
  total: number;
  uniqueErrors: number;
  networkErrors: number;
  projectsCount: number;
  from: number;
  to: number;
  intervalMs: number;
  trend: TrendBucket[];
  types: Breakdown[];
  projects: Breakdown[];
  environments: Breakdown[];
  releases: Breakdown[];
  pages: Breakdown[];
  runtimes: Breakdown[];
  httpStatuses: Breakdown[];
  topErrors: TopError[];
};

const types = Object.keys(EVENT_LABELS) as EventType[];
const minute = 60_000;
const day = 24 * 60 * minute;
const steps = [5 * minute, 15 * minute, 60 * minute, 6 * 60 * minute, day, 7 * day];

function emptyTypes(): Record<EventType, number> {
  return Object.fromEntries(types.map(type => [type, 0])) as Record<EventType, number>;
}

function add(map: Map<string, Breakdown>, key: string, label = key): void {
  const existing = map.get(key);
  if (existing) existing.count++;
  else map.set(key, { key, label, count: 1 });
}

function ordered(map: Map<string, Breakdown>): Breakdown[] {
  return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function bucketCount(from: number, to: number, interval: number): number {
  return Math.floor(to / interval) - Math.floor(from / interval) + 1;
}

function intervalFor(from: number, to: number): number {
  const step = steps.find(candidate => bucketCount(from, to, candidate) <= 100);
  if (step) return step;
  let interval = 7 * day * Math.max(1, Math.ceil((to - from + 1) / (99 * 7 * day)));
  while (bucketCount(from, to, interval) > 100) interval += 7 * day;
  return interval;
}

function parseBound(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} date is invalid.`);
  return parsed;
}

export function buildAnalytics(events: ErrorEventRecord[], range: { from?: string; to?: string } = {}): Analytics {
  const explicitFrom = parseBound(range.from, 'Start');
  const explicitTo = parseBound(range.to, 'End');
  let earliest = Infinity;
  let latest = -Infinity;
  const timed = events.map(event => {
    const at = Date.parse(event.occurredAt);
    if (!Number.isFinite(at)) throw new Error('Event occurrence time is invalid.');
    earliest = Math.min(earliest, at);
    latest = Math.max(latest, at);
    return { event, at };
  });
  const from = explicitFrom ?? (Number.isFinite(earliest) ? earliest : explicitTo ?? 0);
  const to = explicitTo ?? (Number.isFinite(latest) ? Math.max(latest, from) : from);
  if (from > to) throw new Error('Start date cannot be later than end date.');
  const intervalMs = intervalFor(from, to);
  const firstBucket = Math.floor(from / intervalMs) * intervalMs;
  const trend: TrendBucket[] = Array.from({ length: bucketCount(from, to, intervalMs) }, (_, index) => {
    const start = firstBucket + index * intervalMs;
    return { from: start, to: start + intervalMs - 1, count: 0, types: emptyTypes() };
  });

  const typeCounts = emptyTypes();
  const projects = new Map<string, Breakdown>();
  const environments = new Map<string, Breakdown>();
  const releases = new Map<string, Breakdown>();
  const pages = new Map<string, Breakdown>();
  const runtimes = new Map<string, Breakdown>();
  const httpStatuses = new Map<string, Breakdown>();
  const top = new Map<string, TopError>();
  let total = 0;
  let networkErrors = 0;

  for (const { event, at } of timed) {
    if (at < from || at > to) continue;
    total++;
    typeCounts[event.type]++;
    const bucket = trend[Math.floor(at / intervalMs) - Math.floor(from / intervalMs)];
    bucket.count++;
    bucket.types[event.type]++;
    add(projects, event.project);
    add(environments, event.environment);
    add(releases, JSON.stringify([event.project, event.release]), `${event.project} · ${event.release}`);
    add(pages, event.page);
    add(runtimes, event.runtime);
    if (event.type === 'http' || event.type === 'network') {
      networkErrors++;
      const status = event.network?.status;
      add(httpStatuses, typeof status === 'number' && Number.isFinite(status) && status > 0 ? String(status) : 'No response');
    }
    // This groups matching messages for display; it does not claim a shared root cause.
    const key = JSON.stringify([event.project, event.type, event.message]);
    const existing = top.get(key);
    if (existing) {
      existing.count++;
      if (at > Date.parse(existing.lastOccurredAt) ||
          (at === Date.parse(existing.lastOccurredAt) && event.eventId > existing.event.eventId)) {
        existing.lastOccurredAt = event.occurredAt;
        existing.event = event;
      }
    } else {
      top.set(key, {
        key, message: event.message, project: event.project, type: event.type,
        count: 1, lastOccurredAt: event.occurredAt, event,
      });
    }
  }

  return {
    total,
    uniqueErrors: top.size,
    networkErrors,
    projectsCount: projects.size,
    from,
    to,
    intervalMs,
    trend,
    types: types.map(type => ({ key: type, label: EVENT_LABELS[type], count: typeCounts[type] })),
    projects: ordered(projects),
    environments: ordered(environments),
    releases: ordered(releases),
    pages: ordered(pages),
    runtimes: ordered(runtimes),
    httpStatuses: ordered(httpStatuses),
    topErrors: [...top.values()].sort((a, b) => b.count - a.count ||
      Date.parse(b.lastOccurredAt) - Date.parse(a.lastOccurredAt) || a.key.localeCompare(b.key)).slice(0, 8),
  };
}
