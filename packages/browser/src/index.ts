import { BREADCRUMB_LIMITS, getEventReference, type EventReference, type Breadcrumb, type ErrorEventRecord, type EventBatch, type EventType, type Runtime } from '@ihyeon/browser-error-log-protocol';

export type { Breadcrumb, ErrorEventRecord, EventBatch, EventReference } from '@ihyeon/browser-error-log-protocol';
export { formatEventReference } from '@ihyeon/browser-error-log-protocol';

export interface CaptureExtra {
  type?: EventType;
  context?: Record<string, unknown>;
  componentStack?: string;
}

export interface TransportContext { signal: AbortSignal }

export type BrowserErrorLogPreset = 'minimal' | 'standard' | 'detailed';

export interface BrowserErrorLogOptions {
  project: string;
  environment?: string;
  release?: string;
  /** Scalar metadata added to every captured event; event context takes precedence. */
  context?: Record<string, unknown>;
  /** Returns scalar metadata from current application state for each new event. */
  getContext?: () => Record<string, unknown> | undefined;
  endpoint?: string;
  transport?: (batch: EventBatch, context: TransportContext) => void | Promise<void>;
  runtime?: Runtime;
  enabled?: boolean;
  /** Automatic capture preset; defaults to standard. Explicit capture flags override it. */
  preset?: BrowserErrorLogPreset;
  /** Include error and component stacks; defaults to true except in minimal. */
  captureStack?: boolean;
  captureConsole?: boolean;
  /** Captures global JavaScript errors automatically; defaults to true in standard. */
  captureGlobalErrors?: boolean;
  /** Captures unhandled promise rejections automatically; defaults to true in standard. */
  captureUnhandledRejections?: boolean;
  /** Includes up to four sanitized Error.cause entries in exception stacks; defaults to false in standard. */
  captureErrorCause?: boolean;
  /** Captures script, stylesheet link, and image load errors; defaults to false in standard. */
  captureResourceErrors?: boolean;
  /** Records sanitized History navigation breadcrumbs; defaults to false in standard. */
  captureNavigation?: boolean;
  /** Defaults to true in standard. With a custom transport, automatic network capture requires endpoint for collector exclusion. */
  captureNetwork?: boolean;
  /** Records sanitized fetch/XHR completion breadcrumbs; defaults to false in standard. Custom transports require endpoint. */
  captureNetworkBreadcrumbs?: boolean;
  /** Filters or replaces each sanitized breadcrumb before it enters the trail. */
  beforeBreadcrumb?: (breadcrumb: Breadcrumb) => BreadcrumbInput | false | null | void;
  beforeSend?: (event: ErrorEventRecord) => ErrorEventRecord | false | null | void;
  /** Suppresses events whose final sanitized message contains any listed literal string. */
  ignoreMessages?: readonly string[];
  sanitizeUrl?: (url: string) => string;
  shouldCaptureHttp?: (status: number, url: string, method: string) => boolean;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  /** Maximum events per delivery batch, clamped to 1–20; defaults to 20. */
  maxBatchSize?: number;
  /** Maximum new events admitted in any rolling 60 seconds; disabled by default. */
  maxEventsPerMinute?: number;
  /** Probability of admitting each captured event, from 0 to 1; defaults to 1. */
  sampleRate?: number;
  /** Suppresses matching sanitized events for this many milliseconds; disabled by default. */
  dedupeIntervalMs?: number;
  /** Per-attempt deadline, clamped to 250–60000 ms; defaults to 5000 ms. */
  transportTimeoutMs?: number;
  /** Holds queued delivery and beacons while navigator.onLine is exactly false; defaults to false. */
  pauseWhileOffline?: boolean;
  /** Recent event IDs to retain for delivery status lookup, clamped to 0–100; defaults to 0. */
  deliveryStatusLimit?: number;
}

export interface BrowserErrorLogClient {
  captureException(error: unknown, extra?: CaptureExtra): void;
  flush(): Promise<void>;
  destroy(): void;
  getStats(): { queued: number; sent: number; dropped: number };
}

export interface BreadcrumbInput {
  message: string;
  category?: string;
  data?: Record<string, unknown>;
}

export interface BrowserErrorLogBreadcrumbClient extends BrowserErrorLogClient {
  addBreadcrumb(input: BreadcrumbInput): void;
  clearBreadcrumbs(): void;
}

export type BrowserErrorLogDropReason = 'rateLimit' | 'queueOverflow' | 'payloadTooLarge'
  | 'processingError' | 'deliveryError' | 'destroyed';

export interface BrowserErrorLogDiagnostics {
  queued: number;
  sent: number;
  dropped: number;
  inFlight: number;
  filtered: number;
  deduplicated: number;
  droppedByReason: Record<BrowserErrorLogDropReason, number>;
}

export interface BrowserErrorLogDiagnosticsClient extends BrowserErrorLogBreadcrumbClient {
  getDiagnostics(): BrowserErrorLogDiagnostics;
}

export interface BrowserErrorLogCaptureClient extends BrowserErrorLogDiagnosticsClient {
  /** Returns the accepted event ID, not a delivery or storage acknowledgement. */
  captureException(error: unknown, extra?: CaptureExtra): string | undefined;
}

export type BrowserErrorLogDeliveryStatus =
  | { state: 'unknown' | 'queued' | 'in-flight' | 'transport-accepted' | 'beacon-queued' }
  | { state: 'dropped'; reason: BrowserErrorLogDropReason };

export interface BrowserErrorLogDeliveryClient extends BrowserErrorLogCaptureClient {
  /** Reports only this client's recent SDK delivery state, never collector persistence. */
  getDeliveryStatus(eventId: string): BrowserErrorLogDeliveryStatus;
}

export interface BrowserErrorLogReferenceClient extends BrowserErrorLogDeliveryClient {
  /** Returns the lookup fields for an event admitted to the delivery queue. */
  captureExceptionWithReference(error: unknown, extra?: CaptureExtra): EventReference | undefined;
}

const MAX_BATCH_EVENTS = 20;
const MAX_BATCH_BYTES = 48_000;
const MAX_BEACON_EVENTS = 10;
const MAX_BEACON_BYTES = 24_000;
const RETRY_DELAYS_MS = [250, 500];
const SENSITIVE_KEY = /(?:password|passwd|token|secret|authorization|cookie|session|api.?key|credential|bearer|private.?key)/i;
const EVENT_TYPES = new Set<EventType>(['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual', 'resource']);
const RUNTIMES = new Set<Runtime>(['browser', 'webview-ios', 'webview-android', 'unknown']);
let fallbackId = 0;

function read(object: unknown, key: PropertyKey): unknown {
  try { return object == null ? undefined : Reflect.get(Object(object), key); }
  catch { return undefined; }
}

function safeString(value: unknown): string {
  try { return String(value); }
  catch { return '[unavailable]'; }
}

function trim(value: unknown, length: number): string {
  return safeString(value).slice(0, length);
}

function now(): number {
  try { return performance.now(); }
  catch { return Date.now(); }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${(++fallbackId).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isAbort(error: unknown, signal?: AbortSignal | null): boolean {
  try { if (signal?.aborted) return true; }
  catch { /* ignore hostile signal */ }
  return read(error, 'name') === 'AbortError' || read(error, 'code') === 20;
}

function errorFields(error: unknown, includeStack = true): { message: string; name?: string; stack?: string } {
  if (error === null || error === undefined) return { message: 'Unknown error' };
  const message = read(error, 'message');
  const name = read(error, 'name');
  const stack = includeStack ? read(error, 'stack') : undefined;
  return {
    message: message == null ? safeString(error) : safeString(message),
    ...(name == null ? {} : { name: safeString(name) }),
    ...(stack == null ? {} : { stack: safeString(stack) }),
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

function captureFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function eventFingerprint(event: ErrorEventRecord): string {
  return JSON.stringify([
    event.type, event.name ?? null, event.message, event.stack ?? null,
    event.componentStack ?? null, event.project, event.environment, event.release,
    event.page, event.runtime, event.browser ?? null,
    event.context === undefined ? null : Object.keys(event.context).sort().map(key => [key, event.context![key]]),
    event.network === undefined ? null : [event.network.method, event.network.url, event.network.status ?? null],
  ]);
}

class HttpDeliveryError extends Error {
  constructor(readonly status: number) { super(`Collector responded ${status}`); }
}

class UrlSanitizationError extends Error {}

class ContextResolutionError extends Error {}

class Client implements BrowserErrorLogReferenceClient {
  private readonly active: boolean;
  private readonly endpoint?: string;
  private readonly options: BrowserErrorLogOptions;
  private readonly networkCaptureEnabled: boolean;
  private readonly networkBreadcrumbCaptureEnabled: boolean;
  private readonly navigationCaptureEnabled: boolean;
  private readonly captureErrorCause: boolean;
  private readonly captureStack: boolean;
  private readonly consoleCaptureEnabled: boolean;
  private readonly captureGlobalErrors: boolean;
  private readonly captureUnhandledRejections: boolean;
  private readonly resourceCaptureEnabled: boolean;
  private readonly pauseWhileOffline: boolean;
  private readonly transportTimeoutMs: number;
  private readonly deliveryStatusLimit: number;
  private readonly deliveryStatuses?: Map<string, BrowserErrorLogDeliveryStatus>;
  private readonly startedAt = now();
  private readonly viewId = newId();
  private readonly seenErrors = new WeakSet<object>();
  private readonly queue: ErrorEventRecord[] = [];
  private readonly breadcrumbs: Breadcrumb[] = [];
  private recordingBreadcrumb = false;
  private readonly maxQueueSize: number;
  private readonly maxBatchSize: number;
  private readonly maxEventsPerMinute?: number;
  private readonly sampleRate: number;
  private readonly dedupeIntervalMs: number;
  private readonly ignoreMessages: readonly string[];
  private readonly dedupeCache = new Map<string, number>();
  private lastDedupeClock?: number;
  private readonly admittedAt: number[] = [];
  private readonly cancelWaits = new Set<() => void>();
  private readonly controllers = new Set<AbortController>();
  private interval?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private onlineFlushRequested = false;
  private sequence = 0;
  private inFlight = 0;
  private activeBatch?: { batch: EventBatch; eventIds: string[]; beaconedIds: Set<string>; acceptedIds: Set<string>; failedIds: Set<string> };
  private sent = 0;
  private dropped = 0;
  private filtered = 0;
  private deduplicated = 0;
  private readonly droppedByReason: Record<BrowserErrorLogDropReason, number> = {
    rateLimit: 0, queueOverflow: 0, payloadTooLarge: 0,
    processingError: 0, deliveryError: 0, destroyed: 0,
  };
  private destroyed = false;
  private lastAdmissionClock?: number;

  constructor(options: BrowserErrorLogOptions) {
    this.options = options;
    this.active = options.enabled !== false && typeof window !== 'undefined' && typeof document !== 'undefined';
    const preset = options.preset ?? 'standard';
    if (preset !== 'minimal' && preset !== 'standard' && preset !== 'detailed') throw new Error('preset must be minimal, standard, or detailed');
    const minimal = preset === 'minimal';
    const detailed = preset === 'detailed';
    const automaticNetworkAllowed = !options.transport || Boolean(options.endpoint);
    this.networkCaptureEnabled = captureFlag(options.captureNetwork, !minimal) && automaticNetworkAllowed;
    this.networkBreadcrumbCaptureEnabled = captureFlag(options.captureNetworkBreadcrumbs, detailed) && automaticNetworkAllowed;
    this.navigationCaptureEnabled = captureFlag(options.captureNavigation, detailed);
    this.captureErrorCause = captureFlag(options.captureErrorCause, detailed);
    this.captureStack = captureFlag(options.captureStack, !minimal);
    this.captureGlobalErrors = captureFlag(options.captureGlobalErrors, !minimal);
    this.captureUnhandledRejections = captureFlag(options.captureUnhandledRejections, !minimal);
    this.resourceCaptureEnabled = captureFlag(options.captureResourceErrors, detailed);
    this.consoleCaptureEnabled = captureFlag(options.captureConsole, detailed);
    this.pauseWhileOffline = options.pauseWhileOffline === true;
    this.maxQueueSize = boundedNumber(options.maxQueueSize, 1, 100, 50);
    this.maxBatchSize = boundedNumber(options.maxBatchSize, 1, MAX_BATCH_EVENTS, MAX_BATCH_EVENTS);
    this.maxEventsPerMinute = typeof options.maxEventsPerMinute === 'number' && Number.isFinite(options.maxEventsPerMinute)
      ? boundedNumber(options.maxEventsPerMinute, 1, 1000, 1) : undefined;
    this.sampleRate = typeof options.sampleRate === 'number' && Number.isFinite(options.sampleRate)
      ? Math.min(1, Math.max(0, options.sampleRate)) : 1;
    this.dedupeIntervalMs = boundedNumber(options.dedupeIntervalMs, 0, 60_000, 0);
    this.ignoreMessages = Array.isArray(options.ignoreMessages)
      ? options.ignoreMessages.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [];
    this.transportTimeoutMs = boundedNumber(options.transportTimeoutMs, 250, 60_000, 5_000);
    this.deliveryStatusLimit = boundedNumber(options.deliveryStatusLimit, 0, 100, 0);
    if (this.deliveryStatusLimit > 0) this.deliveryStatuses = new Map();
    if (!this.active) return;
    if (!options.project || typeof options.project !== 'string') throw new Error('project is required');
    if (!options.transport && !options.endpoint) throw new Error('endpoint or transport is required');
    this.endpoint = options.endpoint ? this.absoluteUrl(options.endpoint) : undefined;
    if (this.captureGlobalErrors) window.addEventListener('error', this.onError);
    if (this.resourceCaptureEnabled) window.addEventListener('error', this.onResourceError, true);
    if (this.captureUnhandledRejections) window.addEventListener('unhandledrejection', this.onRejection);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    if (this.pauseWhileOffline) window.addEventListener('online', this.onOnline);
    if (this.networkCaptureEnabled || this.networkBreadcrumbCaptureEnabled) addNetworkClient(this);
    if (this.consoleCaptureEnabled) addConsoleClient(this);
    if (this.navigationCaptureEnabled) addNavigationClient(this);
    this.interval = setInterval(() => { void this.flush(); }, boundedNumber(options.flushIntervalMs, 10, 60_000, 10_000));
  }

  captureException(error: unknown, extra: CaptureExtra = {}): string | undefined {
    return this.captureExceptionInternal(error, extra)?.eventId;
  }

  captureExceptionWithReference(error: unknown, extra: CaptureExtra = {}): EventReference | undefined {
    const event = this.captureExceptionInternal(error, extra);
    return event && getEventReference(event);
  }

  private captureExceptionInternal(error: unknown, extra: CaptureExtra,
    nativeLocation?: { filename: string; lineno: number; colno: number }): ErrorEventRecord | undefined {
    if (!this.active || this.destroyed || isAbort(error)) return;
    try {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        if (this.seenErrors.has(error)) { this.deduplicated++; return; }
      }
      const fields = this.exceptionFields(error, nativeLocation);
      const type = EVENT_TYPES.has(extra.type as EventType) ? extra.type! : 'manual';
      const event = this.makeEvent(type, fields.message, {
        name: fields.name,
        stack: fields.stack,
        componentStack: this.captureStack ? extra.componentStack : undefined,
        context: extra.context,
      });
      if (this.enqueue(event)) {
        if (error !== null && (typeof error === 'object' || typeof error === 'function')) this.seenErrors.add(error);
        return event;
      }
    } catch (error) {
      if (error instanceof UrlSanitizationError || error instanceof ContextResolutionError) this.recordDrop('processingError');
      // Diagnostics must never affect the host app.
    }
  }

  reportNetwork(method: string, url: string, status: number | undefined, durationMs: number,
    failure?: unknown, allowErrorCapture = true): void {
    if (this.destroyed || !this.active || this.isCollectorUrl(url) || isAbort(failure)) return;
    let captureError = this.networkCaptureEnabled && allowErrorCapture;
    if (captureError && status !== undefined) {
      try {
        captureError = this.options.shouldCaptureHttp
          ? this.options.shouldCaptureHttp(status, url, method)
          : status >= 500;
      } catch { this.recordDrop('processingError'); return; /* A failing hook cannot expose an unfiltered event or breadcrumb. */ }
    }
    if (this.networkBreadcrumbCaptureEnabled) {
      try {
        const cleaned = this.cleanBreadcrumbUrl(url);
        if (cleaned.url) {
          const data: NonNullable<Breadcrumb['data']> = {
            method: this.cleanNetworkBreadcrumbMethod(method),
            url: cleaned.url,
            durationMs: boundedNumber(durationMs, 0, 3_600_000, 0),
          };
          if (status !== undefined && Number.isInteger(status) && status >= 0 && status <= 599) data.status = status;
          this.appendBreadcrumb({ occurredAt: new Date().toISOString(),
            category: status === undefined ? 'network' : 'http',
            message: status === undefined ? 'Network failure' : 'HTTP response', data });
        } else if (captureError && !cleaned.safeForError) {
          this.recordDrop('processingError');
          return;
        }
      } catch {
        if (captureError) this.recordDrop('processingError');
        return; // A failing URL hook cannot expose an unfiltered breadcrumb or selected error.
      }
    }
    if (!captureError) return;
    try {
      const network = { method: trim(method || 'GET', 16).toUpperCase(), url, status, durationMs };
      const fields = failure === undefined ? undefined : errorFields(failure, false);
      const event = this.makeEvent(status === undefined ? 'network' : 'http',
        status === undefined ? (fields?.message || 'Network request failed') : `HTTP ${status}`,
        { name: fields?.name, network });
      this.enqueue(event);
    } catch { this.recordDrop('processingError'); /* a failing hook must not expose an unfiltered event */ }
  }

  reportZeroStatusCompletion(method: string, url: string, durationMs: number): void {
    if (this.networkBreadcrumbCaptureEnabled) this.reportNetwork(method, url, 0, durationMs, undefined, false);
  }

  captureConsole(values: unknown[]): void {
    if (!this.active || this.destroyed) return;
    try {
      const message = values.map(safeString).join(' ');
      let fields: ReturnType<typeof errorFields> | undefined;
      for (const value of values) {
        let isError = false;
        try { isError = value instanceof Error; }
        catch { /* a hostile value must not suppress the console event */ }
        if (isError) { fields = this.exceptionFields(value); break; }
      }
      this.enqueue(this.makeEvent('console', message, { name: fields?.name, stack: fields?.stack }));
    }
    catch { this.recordDrop('processingError'); /* console behavior is never changed by capture */ }
  }

  addBreadcrumb(input: BreadcrumbInput): void {
    if (!this.active || this.destroyed || this.recordingBreadcrumb) return;
    try {
      const breadcrumb = this.cleanBreadcrumb(input, new Date().toISOString());
      if (!breadcrumb) return;
      this.appendBreadcrumb(breadcrumb);
    } catch { /* Diagnostics must never affect the host app or error stats. */ }
  }

  private appendBreadcrumb(breadcrumb: Breadcrumb): void {
    if (this.recordingBreadcrumb || this.destroyed) return;
    if (!this.options.beforeBreadcrumb) {
      this.breadcrumbs.push(breadcrumb);
      this.boundBreadcrumbs(this.breadcrumbs);
      return;
    }
    this.recordingBreadcrumb = true;
    try {
      const copy = { ...breadcrumb, ...(breadcrumb.data ? { data: { ...breadcrumb.data } } : {}) };
      const result = this.options.beforeBreadcrumb(copy);
      if (result === false || result === null) return;
      const cleaned = this.cleanBreadcrumb(result === undefined ? copy : result, breadcrumb.occurredAt);
      if (!cleaned || this.destroyed) return;
      this.breadcrumbs.push(cleaned);
      this.boundBreadcrumbs(this.breadcrumbs);
    } catch { /* A breadcrumb hook cannot affect the host app or error stats. */ }
    finally { this.recordingBreadcrumb = false; }
  }

  reportNavigation(fromHref: string, toHref: string, trigger: NavigationTrigger): void {
    if (!this.active || this.destroyed || !this.navigationCaptureEnabled) return;
    try {
      const from = this.cleanBreadcrumbUrl(fromHref).url;
      const to = this.cleanBreadcrumbUrl(toHref).url;
      if (!from || !to) return;
      if (from === to) return;
      this.appendBreadcrumb({ occurredAt: new Date().toISOString(), category: 'navigation',
        message: 'Navigation', data: { from, to, trigger } });
    } catch { /* A failing URL hook cannot affect navigation or expose an unfiltered breadcrumb. */ }
  }

  clearBreadcrumbs(): void {
    if (!this.active || this.destroyed) return;
    this.breadcrumbs.length = 0;
  }

  flush(): Promise<void> {
    if (!this.active || this.destroyed) return Promise.resolve();
    if (this.flushing) return this.flushing;
    let startDrain!: (result: Promise<void>) => void;
    const drainResult = new Promise<void>(resolve => { startDrain = resolve; });
    // Publish the flush before drain can enter a synchronous transport callback.
    this.flushing = drainResult.finally(() => {
      this.flushing = undefined;
      if (this.onlineFlushRequested) {
        this.onlineFlushRequested = false;
        if (!this.destroyed && this.queue.length && !this.isExplicitlyOffline()) void this.flush();
      }
    });
    startDrain(this.drain());
    return this.flushing;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.interval) clearInterval(this.interval);
    if (this.active) {
      if (this.captureGlobalErrors) window.removeEventListener('error', this.onError);
      if (this.resourceCaptureEnabled) window.removeEventListener('error', this.onResourceError, true);
      if (this.captureUnhandledRejections) window.removeEventListener('unhandledrejection', this.onRejection);
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('pagehide', this.onPageHide);
      if (this.pauseWhileOffline) window.removeEventListener('online', this.onOnline);
      if (this.networkCaptureEnabled || this.networkBreadcrumbCaptureEnabled) removeNetworkClient(this);
      if (this.consoleCaptureEnabled) removeConsoleClient(this);
      if (this.navigationCaptureEnabled) removeNavigationClient(this);
    }
    const active = this.activeBatch;
    const pending = active
      ? active.eventIds.filter(id => !active.beaconedIds.has(id) && !active.acceptedIds.has(id) && !active.failedIds.has(id)).length
      : this.inFlight;
    this.recordDrop('destroyed', this.queue.length + pending);
    if (this.deliveryStatuses) {
      for (const [eventId, status] of this.deliveryStatuses) {
        if (status.state === 'queued' || status.state === 'in-flight') {
          this.deliveryStatuses.set(eventId, { state: 'dropped', reason: 'destroyed' });
        }
      }
    }
    this.queue.length = 0;
    this.breadcrumbs.length = 0;
    this.admittedAt.length = 0;
    this.lastAdmissionClock = undefined;
    this.dedupeCache.clear();
    this.lastDedupeClock = undefined;
    for (const cancel of this.cancelWaits) cancel();
    for (const controller of this.controllers) controller.abort();
  }

  getStats(): { queued: number; sent: number; dropped: number } {
    return { queued: this.queue.length, sent: this.sent, dropped: this.dropped };
  }

  getDiagnostics(): BrowserErrorLogDiagnostics {
    return { ...this.getStats(), inFlight: this.destroyed ? 0 : this.inFlight,
      filtered: this.filtered, deduplicated: this.deduplicated,
      droppedByReason: { ...this.droppedByReason } };
  }

  getDeliveryStatus(eventId: string): BrowserErrorLogDeliveryStatus {
    return { ...(this.deliveryStatuses?.get(eventId) ?? { state: 'unknown' }) };
  }

  private admitDeliveryStatus(eventId: string): void {
    const statuses = this.deliveryStatuses;
    if (!statuses) return;
    if (statuses.size >= this.deliveryStatusLimit) {
      statuses.delete(statuses.keys().next().value!);
    }
    statuses.set(eventId, { state: 'queued' });
  }

  private setDeliveryStatus(eventIds: readonly string[], status: BrowserErrorLogDeliveryStatus): void {
    if (!this.deliveryStatuses) return;
    for (const eventId of eventIds) {
      if (this.deliveryStatuses.has(eventId)) this.deliveryStatuses.set(eventId, status);
    }
  }

  private recordDrop(reason: BrowserErrorLogDropReason, count = 1): void {
    this.dropped += count;
    this.droppedByReason[reason] += count;
  }

  private readonly onError = (event: ErrorEvent): void => {
    try {
      // Browsers can expose a Window proxy as the target; only global errors belong here.
      if (!(read(event, 'target') instanceof Window)) return;
      const filename = read(event, 'filename');
      const lineno = read(event, 'lineno');
      const colno = read(event, 'colno');
      const context: Record<string, unknown> = {};
      if (typeof filename === 'string' && filename.trim()) context.filename = this.cleanUrl(filename);
      if (typeof lineno === 'number' && Number.isFinite(lineno) && lineno > 0) context.lineno = lineno;
      if (typeof colno === 'number' && Number.isFinite(colno) && colno > 0) context.colno = colno;
      this.captureExceptionInternal(read(event, 'error') ?? read(event, 'message') ?? 'Script error', {
        type: 'javascript', ...(Object.keys(context).length ? { context } : {}),
      }, typeof filename === 'string' && typeof lineno === 'number' && typeof colno === 'number' &&
        Number.isSafeInteger(lineno) && Number.isSafeInteger(colno) && lineno > 0 && colno > 0
        ? { filename, lineno, colno } : undefined);
    } catch { this.recordDrop('processingError'); /* a failing URL hook must not affect the host app */ }
  };

  private readonly onResourceError = (event: Event): void => {
    if (this.destroyed || !this.active) return;
    try {
      const target = read(event, 'target');
      if (read(target, 'ownerDocument') !== document || !document.contains(target as Node)) return;
      if (read(target, 'namespaceURI') !== 'http://www.w3.org/1999/xhtml') return;
      const localName = read(target, 'localName');
      if (localName !== 'script' && localName !== 'link' && localName !== 'img') return;
      const getAttribute = read(target, 'getAttribute');
      if (typeof getAttribute !== 'function') return;
      const attribute = (name: string): unknown => {
        try { return Reflect.apply(getAttribute, target, [name]); }
        catch { return undefined; }
      };
      const tag: 'script' | 'link' | 'img' = localName;
      let rawUrl: unknown;
      if (tag === 'script') {
        const src = attribute('src');
        if (typeof src !== 'string' || !src.trim()) return;
        rawUrl = read(target, 'src');
      } else if (tag === 'link') {
        const rel = read(target, 'rel');
        if (typeof rel !== 'string' || !rel.split(/\s+/).some(token => token.toLowerCase() === 'stylesheet')) return;
        const href = attribute('href');
        if (typeof href !== 'string' || !href.trim()) return;
        rawUrl = read(target, 'href');
      } else {
        const currentSrc = read(target, 'currentSrc');
        if (typeof currentSrc === 'string' && currentSrc.trim()) rawUrl = currentSrc;
        else {
          const src = attribute('src');
          if (typeof src !== 'string' || !src.trim()) return;
          rawUrl = read(target, 'src');
        }
      }
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) return;
      let source: URL;
      try { source = new URL(rawUrl, window.location.href); }
      catch { return; }
      if (source.protocol !== 'http:' && source.protocol !== 'https:') return;
      if (this.isCollectorUrl(source.href)) return;
      const resourceUrl = this.cleanUrl(source.href);
      let cleaned: URL;
      try { cleaned = new URL(resourceUrl); }
      catch { throw new UrlSanitizationError('Invalid resource URL'); }
      if ((cleaned.protocol !== 'http:' && cleaned.protocol !== 'https:') || cleaned.username || cleaned.password || cleaned.search || cleaned.hash) {
        throw new UrlSanitizationError('Unsafe resource URL');
      }
      this.enqueue(this.makeEvent('resource', `Failed to load ${tag} resource`, {
        name: 'ResourceLoadError', context: { resourceTag: tag, resourceUrl },
      }));
    } catch (error) {
      if (error instanceof UrlSanitizationError || error instanceof ContextResolutionError) this.recordDrop('processingError');
      // A hostile DOM value or hook must not change the host application's error behavior.
    }
  };

  private readonly onRejection = (event: PromiseRejectionEvent): void => {
    this.captureException(event.reason, { type: 'promise' });
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.tryBeacon();
  };

  private readonly onPageHide = (): void => {
    this.tryBeacon(true);
  };

  private readonly onOnline = (): void => {
    if (!this.active || this.destroyed || !this.queue.length || this.isExplicitlyOffline()) return;
    if (this.flushing) this.onlineFlushRequested = true;
    else void this.flush();
  };

  private isExplicitlyOffline(): boolean {
    if (!this.pauseWhileOffline) return false;
    try { return typeof navigator !== 'undefined' && navigator.onLine === false; }
    catch { return false; }
  }

  private absoluteUrl(url: string): string {
    try { return new URL(url, window.location.href).href; }
    catch { return url; }
  }

  private isCollectorUrl(url: string): boolean {
    if (!this.endpoint) return false;
    try {
      const request = new URL(url, window.location.href);
      const collector = new URL(this.endpoint, window.location.href);
      return request.origin === collector.origin && request.pathname === collector.pathname;
    } catch { return url === this.endpoint; }
  }

  private cleanUrl(input: unknown): string {
    let value = safeString(input);
    if (this.options.sanitizeUrl) {
      try { value = this.options.sanitizeUrl(value); }
      catch { throw new UrlSanitizationError('URL sanitizer failed'); }
      if (typeof value !== 'string' || !value) throw new UrlSanitizationError('URL sanitizer returned no URL');
    }
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[unsupported URL]';
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return this.cleanText(url.href, 1024, false);
    } catch { return this.cleanText(value, 1024, false).split(/[?#]/, 1)[0]; }
  }

  private cleanBreadcrumbUrl(input: string): { url?: string; safeForError: boolean } {
    const cleaned = this.cleanUrl(input);
    if (cleaned === '[unsupported URL]') return { safeForError: true };
    try {
      // cleanUrl's malformed-input fallback is for general diagnostics; breadcrumbs need a valid URL.
      const url = new URL(cleaned);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
        return { safeForError: false };
      }
      return { url: cleaned.slice(0, BREADCRUMB_LIMITS.dataString), safeForError: true };
    } catch { return { safeForError: false }; }
  }

  private cleanNetworkBreadcrumbMethod(input: string): string {
    const method = safeString(input || 'GET').trim().toUpperCase();
    return /^[A-Z0-9!#$%&'*+.^_`|~-]{1,16}$/.test(method) ? method : 'GET';
  }

  private cleanText(input: unknown, length: number, replaceUrls = true): string {
    let value = safeString(input);
    if (replaceUrls) {
      value = value.replace(/https?:\/\/[^\s<>"'()[\]]+/gi, match => this.cleanUrl(match));
      value = value.replace(/(^|[\s"'(\[=])((?:\/(?!\/)|\.{1,2}\/)[^\s<>"'()[\]?#]*[?#][^\s<>"'()[\]]+|[a-z][\w.-]*(?:\/[^\s<>"'()[\]?#]*)?(?:\?[a-z0-9_.-]+=[^\s<>"'()[\]]+|#[^\s<>"'()[\]]+)|\?[a-z0-9_.-]+=[^\s<>"'()[\]]+)/gi,
        (_match, prefix: string, url: string) => {
          const punctuation = /[.,;!]+$/.exec(url)?.[0] ?? '';
          const core = url.slice(0, url.length - punctuation.length);
          const cleaned = this.options.sanitizeUrl
            ? this.cleanUrl(core)
            : core.startsWith('?') ? '[redacted query]' : this.cleanText(core.split(/[?#]/, 1)[0], 1024, false);
          return `${prefix}${cleaned}${punctuation}`;
        });
    }
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
      .slice(0, length);
  }

  private observedStackUrls(): Map<string, boolean> {
    // Other resources can rule out ambiguous URL tails, but only scripts attest a frame.
    const urls = new Map<string, boolean>();
    try {
      const scripts = document.scripts;
      for (let index = 0; index < Math.min(scripts.length, 256); index++) {
        const url = scripts[index]?.src;
        if (url && url.length <= 4096) urls.set(url, true);
      }
    } catch { /* unavailable DOM */ }
    try {
      const resources = performance.getEntriesByType('resource');
      for (let index = 0; index < Math.min(resources.length, 256); index++) {
        const entry = resources[index] as PerformanceResourceTiming;
        if (entry.name && entry.name.length <= 4096) {
          urls.set(entry.name, urls.get(entry.name) === true || entry.initiatorType === 'script');
        }
      }
    } catch { /* unavailable resource timing */ }
    return urls;
  }

  private cleanStackText(input: unknown, length: number): string {
    const raw = safeString(input);
    const clean = this.cleanText(raw, length);
    // A caller's sanitizer may intentionally change the asset identity.
    if (this.options.sanitizeUrl || !/[?#]/.test(raw)) return clean;
    const rawPrefix = raw.slice(0, length);
    const rawLines = rawPrefix.split('\n');
    const cleanLines = clean.split('\n');
    if (rawLines.length !== cleanLines.length) return clean;
    let observed: Map<string, boolean> | undefined;
    for (let index = 0; index < rawLines.length; index++) {
      const rawLine = rawLines[index];
      if (!/[?#]/.test(rawLine) || (index === rawLines.length - 1 && raw.length >= length && !rawPrefix.endsWith('\n'))) continue;
      if ((rawLine.match(/https?:\/\//g) ?? []).length !== 1) continue;
      const v8 = /^\s*at\s+(?:[^()\n]*\()?((?:https?):\/\/[^\s()]+):([1-9]\d*):([1-9]\d*)(\))?\s*$/u.exec(rawLine);
      const gecko = /^(?:[^@\n]*@)?((?:https?):\/\/\S+):([1-9]\d*):([1-9]\d*)\s*$/u.exec(rawLine);
      const match = v8 ?? gecko;
      if (!match) continue;
      const [, rawUrl, line, column] = match;
      if (!/[?#]/.test(rawUrl) || !Number.isSafeInteger(Number(line)) || !Number.isSafeInteger(Number(column))) continue;
      try {
        const parsed = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      } catch { continue; }
      observed ??= this.observedStackUrls();
      if (!observed.get(rawUrl) || observed.has(`${rawUrl}:${line}:${column}`)) continue;
      const cleanLine = cleanLines[index];
      if (cleanLine !== this.cleanText(rawLine, length)) continue;
      const safeUrl = this.cleanUrl(rawUrl);
      const closing = v8?.[4] ?? '';
      const expectedEnd = `${safeUrl}${closing}`;
      const suffix = `:${line}:${column}`;
      if (!cleanLine.endsWith(expectedEnd) || cleanLines.join('\n').length + suffix.length > length) continue;
      cleanLines[index] = `${cleanLine.slice(0, -expectedEnd.length)}${safeUrl}${suffix}${closing}`;
    }
    return cleanLines.join('\n');
  }

  private restoreGlobalStackLocation(rawStack: string, cleanStack: string,
    { filename, lineno, colno }: { filename: string; lineno: number; colno: number }): string {
    const rawLines = rawStack.slice(0, 4096).split('\n');
    const cleanLines = cleanStack.split('\n');
    const suffix = `:${lineno}:${colno}`;
    for (let index = 0; index < rawLines.length; index++) {
      const rawLine = rawLines[index];
      const isV8 = /^\s*at\s+/.test(rawLine);
      const isFirefox = /^[^@\n]*@https?:\/\//.test(rawLine);
      if (!isV8 && !isFirefox) continue;
      if (rawStack.length > 4096 && index === rawLines.length - 1) return cleanStack;
      const match = isV8
        ? /^\s*at\s+(?:[^()\n]*\()?((?:https?):\/\/[^\s()]+):(\d+):(\d+)(\))?\s*$/.exec(rawLine)
        : /^[^@\n]*@((?:https?):\/\/[^\s()]+):(\d+):(\d+)\s*$/.exec(rawLine);
      if (!match || match[1] !== filename || Number(match[2]) !== lineno ||
        Number(match[3]) !== colno) return cleanStack;

      const cleanLine = cleanLines[index];
      if (!cleanLine || cleanLine !== this.cleanText(rawLine, 4096)) return cleanStack;
      const cleanFilename = this.cleanUrl(filename);
      const expectedEnd = `${cleanFilename}${match[4] ?? ''}`;
      if (!cleanLine.endsWith(expectedEnd) || cleanStack.length + suffix.length > 4096) return cleanStack;
      cleanLines[index] = `${cleanLine.slice(0, -expectedEnd.length)}${cleanFilename}${suffix}${match[4] ?? ''}`;
      return cleanLines.join('\n');
    }
    return cleanStack;
  }

  private exceptionFields(error: unknown,
    nativeLocation?: { filename: string; lineno: number; colno: number }): ReturnType<typeof errorFields> {
    const fields = errorFields(error, this.captureStack);
    if (nativeLocation && fields.stack && !this.options.sanitizeUrl && /[?#]/.test(nativeLocation.filename)) {
      fields.stack = this.restoreGlobalStackLocation(
        fields.stack, this.cleanText(fields.stack, 4096), nativeLocation,
      );
    }
    if (!this.captureStack || !this.captureErrorCause || error === null || (typeof error !== 'object' && typeof error !== 'function')) return fields;
    const seen = new WeakSet<object>([error]);
    const segments: string[] = [];
    let current: object = error;
    for (let depth = 0; depth < 4; depth++) {
      const cause = read(current, 'cause');
      if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function') || seen.has(cause)) break;
      seen.add(cause);
      const message = read(cause, 'message');
      const stack = read(cause, 'stack');
      if (typeof message !== 'string' && typeof stack !== 'string') break;
      const name = read(cause, 'name');
      const safeName = this.cleanText(typeof name === 'string' ? name : 'Error', 100);
      const safeMessage = typeof message === 'string' ? this.cleanText(message, 256) : '';
      const safeStack = typeof stack === 'string' ? this.cleanStackText(stack, 480) : '';
      segments.push(`Caused by: ${safeName}: ${safeMessage}${safeStack ? `\n${safeStack}` : ''}`.slice(0, 480));
      current = cause;
    }
    if (!segments.length) return fields;
    const outer = fields.stack === undefined
      ? `${this.cleanText(fields.name ?? 'Error', 100)}: ${this.cleanText(fields.message, 256)}`
      : this.cleanStackText(fields.stack, 2048);
    return { ...fields, stack: `${outer}\n${segments.join('\n')}` };
  }

  private cleanContext(input: unknown): ErrorEventRecord['context'] {
    if (!input || typeof input !== 'object') return undefined;
    const output: NonNullable<ErrorEventRecord['context']> = {};
    let keys: string[];
    try { keys = Object.keys(input); }
    catch { return undefined; }
    for (const key of keys) {
      if (Object.keys(output).length >= 12) break;
      if (SENSITIVE_KEY.test(key)) continue;
      const value = read(input, key);
      const safeKey = this.cleanText(key, 80);
      if (typeof value === 'string') output[safeKey] = this.cleanText(value, 500);
      else if (typeof value === 'number' && Number.isFinite(value)) output[safeKey] = value;
      else if (typeof value === 'boolean' || value === null) output[safeKey] = value;
    }
    return Object.keys(output).length ? output : undefined;
  }

  private cleanBreadcrumb(input: unknown, timestamp?: string): Breadcrumb | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const occurredAt = timestamp ?? read(input, 'occurredAt');
    if (typeof occurredAt !== 'string') return undefined;
    try { if (new Date(occurredAt).toISOString() !== occurredAt) return undefined; }
    catch { return undefined; }
    const rawCategory = read(input, 'category');
    const rawMessage = read(input, 'message');
    if ((rawCategory !== undefined && typeof rawCategory !== 'string') || typeof rawMessage !== 'string') return undefined;
    const category = this.cleanText(rawCategory ?? (timestamp ? 'manual' : ''), BREADCRUMB_LIMITS.category);
    const message = this.cleanText(rawMessage, BREADCRUMB_LIMITS.message);
    if (!category.trim() || !message.trim()) return undefined;
    const rawData = read(input, 'data');
    const data: NonNullable<Breadcrumb['data']> = {};
    if (rawData && typeof rawData === 'object') {
      let keys: string[];
      try { keys = Object.keys(rawData); }
      catch { keys = []; }
      for (const key of keys) {
        if (Object.keys(data).length >= BREADCRUMB_LIMITS.dataKeys) break;
        if (SENSITIVE_KEY.test(key)) continue;
        const safeKey = this.cleanText(key, BREADCRUMB_LIMITS.dataKey);
        const value = read(rawData, key);
        if (typeof value === 'string') data[safeKey] = this.cleanText(value, BREADCRUMB_LIMITS.dataString);
        else if (typeof value === 'number' && Number.isFinite(value)) data[safeKey] = value;
        else if (typeof value === 'boolean' || value === null) data[safeKey] = value;
      }
    }
    return { occurredAt, category, message, ...(Object.keys(data).length ? { data } : {}) };
  }

  private boundBreadcrumbs(trail: Breadcrumb[]): void {
    while (trail.length > BREADCRUMB_LIMITS.count || byteLength(JSON.stringify(trail)) > BREADCRUMB_LIMITS.bytes) trail.shift();
  }

  private cleanBreadcrumbTrail(input: unknown): Breadcrumb[] | undefined {
    let length: number;
    try {
      if (!Array.isArray(input)) return undefined;
      length = input.length;
    } catch { return undefined; }
    if (!Number.isSafeInteger(length) || length < 0) return undefined;
    const trail: Breadcrumb[] = [];
    for (let index = Math.max(0, length - BREADCRUMB_LIMITS.count); index < length; index++) {
      const breadcrumb = this.cleanBreadcrumb(read(input, index));
      if (breadcrumb) {
        trail.push(breadcrumb);
        this.boundBreadcrumbs(trail);
      }
    }
    return trail.length ? trail : undefined;
  }

  private cleanNetwork(input: unknown): ErrorEventRecord['network'] {
    if (!input || typeof input !== 'object') return undefined;
    const rawStatus = read(input, 'status');
    const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
      ? rawStatus : undefined;
    return {
      method: this.cleanText(read(input, 'method') ?? 'GET', 16).toUpperCase(),
      url: this.cleanUrl(read(input, 'url') ?? ''),
      ...(status === undefined ? {} : { status }),
      durationMs: boundedNumber(read(input, 'durationMs'), 0, 3_600_000, 0),
    };
  }

  private makeEvent(type: EventType, message: string, extra: {
    name?: string; stack?: string; componentStack?: string;
    context?: unknown; network?: unknown;
  } = {}): ErrorEventRecord {
    const userAgent = read(navigator, 'userAgent');
    const eventContext = this.cleanContext(extra.context);
    let resolved: unknown;
    try { resolved = this.options.getContext?.(); }
    catch { throw new ContextResolutionError('Context resolver failed'); }
    const dynamicContext = this.cleanContext(resolved);
    const defaults = this.cleanContext(this.options.context);
    let context = eventContext;
    if (dynamicContext || defaults) {
      context = { ...eventContext };
      for (const fields of [dynamicContext, defaults]) {
        if (!fields) continue;
        for (const key of Object.keys(fields)) {
          if (Object.keys(context).length >= 12) break;
          if (!Object.prototype.hasOwnProperty.call(context, key)) context[key] = fields[key];
        }
      }
    }
    const network = this.cleanNetwork(extra.network);
    return {
      schemaVersion: 1,
      eventId: newId(),
      project: this.cleanText(this.options.project, 80),
      environment: this.cleanText(this.options.environment ?? 'development', 80),
      release: this.cleanText(this.options.release ?? 'unknown', 120),
      sdkVersion: '0.2.26',
      occurredAt: new Date().toISOString(),
      viewId: this.viewId,
      sequence: ++this.sequence,
      elapsedMs: boundedNumber(now() - this.startedAt, 0, 3_600_000, 0),
      type,
      message: this.cleanText(message, 1024),
      ...(extra.name === undefined ? {} : { name: this.cleanText(extra.name, 100) }),
      ...(this.captureStack && extra.stack !== undefined ? { stack: this.cleanStackText(extra.stack, 4096) } : {}),
      ...(this.captureStack && extra.componentStack !== undefined ? { componentStack: this.cleanStackText(extra.componentStack, 2048) } : {}),
      page: this.cleanUrl(window.location.href),
      runtime: RUNTIMES.has(this.options.runtime as Runtime) ? this.options.runtime! : 'browser',
      ...(typeof userAgent === 'string' ? { browser: this.cleanText(userAgent, 300) } : {}),
      ...(context ? { context } : {}),
      ...(this.breadcrumbs.length ? { breadcrumbs: this.breadcrumbs.map(crumb => ({
        ...crumb, ...(crumb.data ? { data: { ...crumb.data } } : {}),
      })) } : {}),
      ...(network ? { network } : {}),
    };
  }

  private sanitizeReplacement(candidate: unknown, base: ErrorEventRecord): ErrorEventRecord {
    const type = read(candidate, 'type');
    const runtime = read(candidate, 'runtime');
    const name = read(candidate, 'name');
    const stack = this.captureStack ? read(candidate, 'stack') : undefined;
    const componentStack = this.captureStack ? read(candidate, 'componentStack') : undefined;
    const browser = read(candidate, 'browser');
    const context = this.cleanContext(read(candidate, 'context'));
    const breadcrumbs = this.cleanBreadcrumbTrail(read(candidate, 'breadcrumbs'));
    const network = this.cleanNetwork(read(candidate, 'network'));
    return {
      ...base,
      type: EVENT_TYPES.has(type as EventType) ? type as EventType : base.type,
      message: this.cleanText(read(candidate, 'message') ?? base.message, 1024),
      ...(name === undefined ? { name: base.name } : { name: this.cleanText(name, 100) }),
      ...(this.captureStack ? (stack === undefined ? { stack: undefined } : { stack: this.cleanStackText(stack, 4096) }) : {}),
      ...(this.captureStack ? (componentStack === undefined ? { componentStack: base.componentStack } : { componentStack: this.cleanStackText(componentStack, 2048) }) : {}),
      page: this.cleanUrl(read(candidate, 'page') ?? base.page),
      runtime: RUNTIMES.has(runtime as Runtime) ? runtime as Runtime : base.runtime,
      ...(browser === undefined ? { browser: base.browser } : { browser: this.cleanText(browser, 300) }),
      ...(context ? { context } : { context: undefined }),
      ...(breadcrumbs ? { breadcrumbs } : { breadcrumbs: undefined }),
      ...(network ? { network } : { network: undefined }),
    };
  }

  private admissionTime(): number | undefined {
    const reading = now();
    const current = Number.isFinite(reading)
      ? Math.max(0, reading, this.lastAdmissionClock ?? 0)
      : this.lastAdmissionClock ?? 0;
    this.lastAdmissionClock = current;
    while (this.admittedAt.length && current - this.admittedAt[0] >= 60_000) this.admittedAt.shift();
    return this.admittedAt.length < this.maxEventsPerMinute! ? current : undefined;
  }

  private dedupeTime(): number {
    const reading = now();
    const current = Number.isFinite(reading)
      ? Math.max(0, reading, this.lastDedupeClock ?? 0)
      : this.lastDedupeClock ?? 0;
    this.lastDedupeClock = current;
    return current;
  }

  private enqueue(event: ErrorEventRecord): boolean {
    if (this.destroyed) return false;
    if (this.maxEventsPerMinute !== undefined && this.admissionTime() === undefined) {
      this.recordDrop('rateLimit');
      return false;
    }
    let finalEvent = event;
    if (this.options.beforeSend) {
      try {
        const copy = { ...event, context: event.context && { ...event.context },
          breadcrumbs: event.breadcrumbs?.map(crumb => ({ ...crumb, data: crumb.data && { ...crumb.data } })),
          network: event.network && { ...event.network } };
        const result = this.options.beforeSend(copy);
        if (result === false || result === null) { this.filtered++; return false; }
        finalEvent = this.sanitizeReplacement(result === undefined ? copy : result, event);
      } catch { this.recordDrop('processingError'); return false; }
    }
    if (this.destroyed) return false;
    if (this.ignoreMessages.some(message => finalEvent.message.includes(message))) { this.filtered++; return false; }
    if (this.sampleRate === 0 || (this.sampleRate < 1 && Math.random() >= this.sampleRate)) {
      this.filtered++;
      return false;
    }
    // A single event can never make a batch exceed its byte budget.
    if (byteLength(JSON.stringify(finalEvent)) > MAX_BATCH_BYTES) { this.recordDrop('payloadTooLarge'); return false; }
    let fingerprint: string | undefined;
    let dedupeAt: number | undefined;
    if (this.dedupeIntervalMs > 0) {
      dedupeAt = this.dedupeTime();
      for (const [key, acceptedAt] of this.dedupeCache) {
        if (dedupeAt - acceptedAt >= this.dedupeIntervalMs) this.dedupeCache.delete(key);
      }
      fingerprint = eventFingerprint(finalEvent);
      if (this.dedupeCache.has(fingerprint)) { this.deduplicated++; return false; }
    }
    const admittedAt = this.maxEventsPerMinute === undefined ? undefined : this.admissionTime();
    if (this.maxEventsPerMinute !== undefined && admittedAt === undefined) { this.recordDrop('rateLimit'); return false; }
    if (this.queue.length >= this.maxQueueSize) {
      const evicted = this.queue.shift()!;
      this.recordDrop('queueOverflow');
      if (this.deliveryStatuses) {
        this.setDeliveryStatus([evicted.eventId], { state: 'dropped', reason: 'queueOverflow' });
      }
    }
    this.queue.push(finalEvent);
    this.admitDeliveryStatus(finalEvent.eventId);
    if (admittedAt !== undefined) this.admittedAt.push(admittedAt);
    if (fingerprint !== undefined && dedupeAt !== undefined) {
      this.dedupeCache.set(fingerprint, dedupeAt);
      if (this.dedupeCache.size > 50) this.dedupeCache.delete(this.dedupeCache.keys().next().value!);
    }
    if (this.queue.length >= this.maxQueueSize) void this.flush();
    return true;
  }

  private takeBatch(maxEvents = MAX_BATCH_EVENTS, maxBytes = MAX_BATCH_BYTES): EventBatch {
    const events: ErrorEventRecord[] = [];
    let bytes = byteLength('{"schemaVersion":1,"events":[]}');
    while (this.queue.length && events.length < maxEvents) {
      const next = this.queue[0];
      const size = byteLength(JSON.stringify(next)) + (events.length ? 1 : 0);
      if (events.length && bytes + size > maxBytes) break;
      if (!events.length && bytes + size > maxBytes) {
        const oversized = this.queue.shift()!;
        this.recordDrop('payloadTooLarge');
        if (this.deliveryStatuses) {
          this.setDeliveryStatus([oversized.eventId], { state: 'dropped', reason: 'payloadTooLarge' });
        }
        continue;
      }
      events.push(this.queue.shift()!);
      bytes += size;
    }
    return { schemaVersion: 1, events };
  }

  private async drain(): Promise<void> {
    while (!this.destroyed && this.queue.length && !this.isExplicitlyOffline()) {
      const batch = this.takeBatch(this.maxBatchSize);
      if (batch.events.length) {
        const eventIds = batch.events.map(event => event.eventId);
        const count = eventIds.length;
        this.inFlight += count;
        this.activeBatch = { batch, eventIds, beaconedIds: new Set(), acceptedIds: new Set(), failedIds: new Set() };
        this.setDeliveryStatus(eventIds, { state: 'in-flight' });
        try { await this.sendWithRetry(batch, eventIds); }
        finally { this.activeBatch = undefined; this.inFlight -= count; }
      }
    }
  }

  private async sendWithRetry(batch: EventBatch, eventIds: readonly string[]): Promise<void> {
    // A pagehide beacon may have queued part of the original in-flight batch
    // before a split child starts. Do not resend those IDs in a fresh request.
    const pending = batch.events.filter(event => !this.activeBatch?.beaconedIds.has(event.eventId));
    if (!pending.length) return;
    if (pending.length !== batch.events.length) {
      batch = { schemaVersion: 1, events: pending };
      eventIds = pending.map(event => event.eventId);
    }
    // Snapshot custom transport data once so a failed or timed-out callback cannot
    // change what the next attempt sends. Native fetch serializes its own request.
    const originalPayload = this.options.transport ? JSON.stringify(batch) : undefined;
    let needsPristineCopy = false;
    let keepalive = true;
    let splitOnTooLarge = false;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length && !this.destroyed; attempt++) {
      if (attempt > 0 && originalPayload && !needsPristineCopy) {
        try { needsPristineCopy = JSON.stringify(batch) !== originalPayload; }
        catch { needsPristineCopy = true; }
      }
      const attemptBatch = needsPristineCopy && originalPayload
        ? JSON.parse(originalPayload) as EventBatch : batch;
      const controller = new AbortController();
      this.controllers.add(controller);
      let cancelForDestroy!: () => void;
      // Remove this waiter after each attempt; a client-lifetime pending promise
      // would retain one Promise.race reaction for every completed delivery.
      const destroyAttempt = new Promise<symbol>(resolve => {
        cancelForDestroy = () => resolve(DESTROYED);
        this.cancelWaits.add(cancelForDestroy);
      });
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          if (originalPayload) needsPristineCopy = true;
          controller.abort();
          reject(new Error('Collector transport timed out'));
        }, this.transportTimeoutMs);
      });
      let retryDelay: number | undefined;
      try {
        const result = await Promise.race([this.send(attemptBatch, controller.signal, keepalive), timeout, destroyAttempt]);
        if (result === DESTROYED || this.destroyed) return;
        const active = this.activeBatch;
        for (const id of eventIds) {
          if (!active?.beaconedIds.has(id) && !active?.acceptedIds.has(id)) this.sent++;
          active?.acceptedIds.add(id);
        }
        this.setDeliveryStatus(eventIds, { state: 'transport-accepted' });
        return;
      } catch (error) {
        if (this.destroyed) return;
        if (eventIds.every(id => this.activeBatch?.beaconedIds.has(id))) return;
        const status = read(error, 'status');
        if (status === 413 && eventIds.length > 1) { splitOnTooLarge = true; break; }
        // A browser can reject keepalive before sending when another request
        // already occupies its quota. Use a regular fetch on the next attempt.
        if (!this.options.transport && typeof status !== 'number') keepalive = false;
        const retryable = typeof status !== 'number' || status === 429 || status >= 500;
        if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
        retryDelay = RETRY_DELAYS_MS[attempt];
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.cancelWaits.delete(cancelForDestroy);
        this.controllers.delete(controller);
      }
      if (retryDelay !== undefined) await this.wait(retryDelay);
    }
    if (splitOnTooLarge && !this.destroyed) {
      // A collector or proxy may accept smaller requests even when every event
      // in the rejected batch is valid. At most 20 events bound this split tree.
      const pristine = originalPayload ? JSON.parse(originalPayload) as EventBatch : batch;
      const remaining = pristine.events.filter(event => !this.activeBatch?.beaconedIds.has(event.eventId));
      if (!remaining.length) return;
      // Even one survivor needs a fresh request; a second 413 then follows the
      // ordinary single-event failure path instead of splitting recursively.
      if (remaining.length === 1) {
        await this.sendWithRetry({ schemaVersion: 1, events: remaining }, [remaining[0]!.eventId]);
        return;
      }
      const middle = Math.floor(remaining.length / 2);
      const first = remaining.slice(0, middle);
      const second = remaining.slice(middle);
      await this.sendWithRetry({ schemaVersion: 1, events: first }, first.map(event => event.eventId));
      await this.sendWithRetry({ schemaVersion: 1, events: second }, second.map(event => event.eventId));
      return;
    }
    if (!this.destroyed) {
      const beaconedIds = this.activeBatch?.beaconedIds;
      const missing = eventIds.filter(id => !beaconedIds?.has(id));
      if (missing.length) this.recordDrop('deliveryError', missing.length);
      if (missing.length) {
        for (const id of missing) this.activeBatch?.failedIds.add(id);
        this.setDeliveryStatus(missing, { state: 'dropped', reason: 'deliveryError' });
      }
    }
  }

  private async send(batch: EventBatch, signal: AbortSignal, keepalive: boolean): Promise<void> {
    if (this.options.transport) { await this.options.transport(batch, { signal }); return; }
    const response = await window.fetch(this.endpoint!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      credentials: 'omit',
      keepalive,
      signal,
    });
    if (!response.ok) throw new HttpDeliveryError(response.status);
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.cancelWaits.delete(finish); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      this.cancelWaits.add(finish);
    });
  }

  private tryBeacon(backupInFlight = false): void {
    if (this.destroyed || this.options.transport || !this.endpoint ||
        (!this.queue.length && !(backupInFlight && this.activeBatch)) || this.isExplicitlyOffline()) return;
    try {
      const url = new URL(this.endpoint);
      if (url.origin !== window.location.origin || url.search || url.hash || url.username || url.password) return;
      if (typeof navigator.sendBeacon !== 'function') return;
      const sendSnapshot = (events: ErrorEventRecord[], accepted: (batch: ErrorEventRecord[]) => void): boolean => {
        let index = 0;
        while (index < events.length) {
          const candidates = events.slice(index, index + Math.min(this.maxBatchSize, MAX_BEACON_EVENTS));
          while (candidates.length) {
            const body = JSON.stringify({ schemaVersion: 1, events: candidates } satisfies EventBatch);
            if (byteLength(body) <= MAX_BEACON_BYTES) {
              if (!navigator.sendBeacon(this.endpoint!, new Blob([body], { type: 'application/json' })) || this.destroyed) return false;
              accepted(candidates);
              index += candidates.length;
              break;
            }
            candidates.pop();
          }
          if (!candidates.length) return false;
        }
        return true;
      };
      // The normal fetch has removed its batch from the queue. Back it up
      // before queued events because navigation can cancel an in-flight fetch.
      const active = backupInFlight ? this.activeBatch : undefined;
      if (active && !sendSnapshot(active.batch.events.filter(event =>
        !active.beaconedIds.has(event.eventId) && !active.acceptedIds.has(event.eventId) && !active.failedIds.has(event.eventId)), events => {
        for (const event of events) active.beaconedIds.add(event.eventId);
        this.sent += events.length;
        if (this.deliveryStatuses) this.setDeliveryStatus(events.map(event => event.eventId), { state: 'beacon-queued' });
      })) return;
      // Only drain events present at lifecycle entry; newly captured events
      // cannot extend the work or change the batches being delivered.
      sendSnapshot(this.queue.slice(), events => {
        this.queue.splice(0, events.length);
        this.sent += events.length;
        if (this.deliveryStatuses) this.setDeliveryStatus(events.map(event => event.eventId), { state: 'beacon-queued' });
      });
    } catch { /* best effort only */ }
  }
}

const DESTROYED = Symbol('destroyed');

interface Instrumentation {
  clients: Set<Client>;
  cleanup(): void;
}

let networkInstrumentation: Instrumentation | undefined;
let consoleInstrumentation: Instrumentation | undefined;
let navigationInstrumentation: Instrumentation | undefined;

type NavigationTrigger = 'pushState' | 'replaceState' | 'popstate' | 'hashchange';

function addNavigationClient(client: Client): void {
  if (!navigationInstrumentation) navigationInstrumentation = installNavigation();
  navigationInstrumentation?.clients.add(client);
}

function removeNavigationClient(client: Client): void {
  const instrumentation = navigationInstrumentation;
  if (!instrumentation) return;
  instrumentation.clients.delete(client);
  if (!instrumentation.clients.size) {
    instrumentation.cleanup();
    navigationInstrumentation = undefined;
  }
}

function inheritedHistoryDescriptor(historyObject: History, key: 'pushState' | 'replaceState'): PropertyDescriptor | undefined {
  const seen = new Set<object>();
  let prototype = Object.getPrototypeOf(historyObject);
  while (prototype && !seen.has(prototype)) {
    seen.add(prototype);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor) return descriptor;
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}

function installNavigation(): Instrumentation | undefined {
  let historyObject: History;
  let lastHref: string;
  let originalPush: History['pushState'];
  let originalReplace: History['replaceState'];
  let ownPush: PropertyDescriptor | undefined;
  let ownReplace: PropertyDescriptor | undefined;
  let inheritedPush: PropertyDescriptor | undefined;
  let inheritedReplace: PropertyDescriptor | undefined;
  try {
    historyObject = window.history;
    lastHref = window.location.href;
    ownPush = Object.getOwnPropertyDescriptor(historyObject, 'pushState');
    ownReplace = Object.getOwnPropertyDescriptor(historyObject, 'replaceState');
    inheritedPush = ownPush ? undefined : inheritedHistoryDescriptor(historyObject, 'pushState');
    inheritedReplace = ownReplace ? undefined : inheritedHistoryDescriptor(historyObject, 'replaceState');
    if ((ownPush && !('value' in ownPush)) || (ownReplace && !('value' in ownReplace))) return undefined;
    if ((!ownPush && (!inheritedPush || !('value' in inheritedPush) || inheritedPush.writable !== true)) ||
      (!ownReplace && (!inheritedReplace || !('value' in inheritedReplace) || inheritedReplace.writable !== true))) return undefined;
    originalPush = ownPush ? ownPush.value : historyObject.pushState;
    originalReplace = ownReplace ? ownReplace.value : historyObject.replaceState;
    if (typeof originalPush !== 'function' || typeof originalReplace !== 'function') return undefined;
    const canInstall = (own?: PropertyDescriptor) => own
      ? own.configurable === true || own.writable === true
      : Object.isExtensible(historyObject);
    if (!canInstall(ownPush) || !canInstall(ownReplace)) return undefined;
  } catch { return undefined; }

  const clients = new Set<Client>();
  const report = (trigger: NavigationTrigger): void => {
    try {
      const toHref = window.location.href;
      if (toHref === lastHref) return;
      const fromHref = lastHref;
      lastHref = toHref;
      for (const client of clients) {
        try { client.reportNavigation(fromHref, toHref, trigger); }
        catch { /* Telemetry must never alter a successful native call. */ }
      }
    } catch { /* Location can be unavailable in a restricted host. */ }
  };
  const wrappedPush: History['pushState'] = function (this: History, ...args: Parameters<History['pushState']>): void {
    const result = Reflect.apply(originalPush, this, args);
    report('pushState');
    return result;
  };
  const wrappedReplace: History['replaceState'] = function (this: History, ...args: Parameters<History['replaceState']>): void {
    const result = Reflect.apply(originalReplace, this, args);
    report('replaceState');
    return result;
  };
  const onPopState = () => { report('popstate'); };
  const onHashChange = () => { report('hashchange'); };
  const restore = (key: 'pushState' | 'replaceState', wrapper: History['pushState'], own?: PropertyDescriptor): void => {
    try {
      const current = Object.getOwnPropertyDescriptor(historyObject, key);
      if (!current || !('value' in current) || current.value !== wrapper) return;
      if (own) Object.defineProperty(historyObject, key, own);
      else Reflect.deleteProperty(historyObject, key);
    } catch { /* Keep a host-installed replacement and never throw during cleanup. */ }
  };
  let pushInstalled = false;
  let replaceInstalled = false;
  try {
    Object.defineProperty(historyObject, 'pushState', { configurable: ownPush?.configurable ?? true,
      enumerable: ownPush?.enumerable ?? false, writable: ownPush?.writable ?? true, value: wrappedPush });
    pushInstalled = true;
    Object.defineProperty(historyObject, 'replaceState', { configurable: ownReplace?.configurable ?? true,
      enumerable: ownReplace?.enumerable ?? false, writable: ownReplace?.writable ?? true, value: wrappedReplace });
    replaceInstalled = true;
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onHashChange);
  } catch {
    try { window.removeEventListener('hashchange', onHashChange); } catch { /* best effort */ }
    try { window.removeEventListener('popstate', onPopState); } catch { /* best effort */ }
    if (replaceInstalled) restore('replaceState', wrappedReplace, ownReplace);
    if (pushInstalled) restore('pushState', wrappedPush, ownPush);
    return undefined;
  }
  return { clients, cleanup() {
    try { window.removeEventListener('popstate', onPopState); } catch { /* best effort */ }
    try { window.removeEventListener('hashchange', onHashChange); } catch { /* best effort */ }
    restore('pushState', wrappedPush, ownPush);
    restore('replaceState', wrappedReplace, ownReplace);
  } };
}

function addNetworkClient(client: Client): void {
  if (!networkInstrumentation) networkInstrumentation = installNetwork();
  networkInstrumentation.clients.add(client);
}

function removeNetworkClient(client: Client): void {
  const instrumentation = networkInstrumentation;
  if (!instrumentation) return;
  instrumentation.clients.delete(client);
  if (!instrumentation.clients.size) {
    instrumentation.cleanup();
    networkInstrumentation = undefined;
  }
}

function describeFetch(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string; signal?: AbortSignal | null } {
  let requestUrl: string | undefined;
  if (typeof Request !== 'undefined' && input !== null && typeof input === 'object') {
    if (input instanceof Request) requestUrl = read(input, 'url') as string | undefined;
    else {
      try { requestUrl = Object.getOwnPropertyDescriptor(Request.prototype, 'url')?.get?.call(input); }
      catch { /* not a genuine Request */ }
    }
  }
  const initSignal = read(init, 'signal');
  return {
    url: requestUrl ?? safeString(input),
    method: safeString(read(init, 'method') ?? (requestUrl === undefined ? undefined : read(input, 'method')) ?? 'GET'),
    signal: (initSignal === undefined ? (requestUrl === undefined ? undefined : read(input, 'signal')) : initSignal) as AbortSignal | null | undefined,
  };
}

function installNetwork(): Instrumentation {
  const clients = new Set<Client>();
  const originalFetch = window.fetch;
  let wrappedFetch: typeof fetch | undefined;
  if (typeof originalFetch === 'function') {
    wrappedFetch = function (this: typeof window, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
      if (!clients.size) return Reflect.apply(originalFetch, this, args);
      const started = now();
      let request: ReturnType<typeof describeFetch>;
      try { request = describeFetch(args[0], args[1]); }
      catch { request = { url: '', method: 'GET' }; }
      let promise: ReturnType<typeof fetch>;
      try { promise = Reflect.apply(originalFetch, this, args); }
      catch (error) {
        if (!isAbort(error, request.signal)) for (const client of clients) client.reportNetwork(request.method, request.url, undefined, now() - started, error);
        throw error;
      }
      return promise.then(
        response => {
          try {
            const status = response.status;
            for (const client of clients) client.reportNetwork(request.method, request.url, status, now() - started);
          } catch { /* telemetry cannot change the fetch result */ }
          return response;
        },
        error => {
          if (!isAbort(error, request.signal)) for (const client of clients) client.reportNetwork(request.method, request.url, undefined, now() - started, error);
          throw error;
        },
      );
    };
    window.fetch = wrappedFetch;
  }

  const prototype = typeof XMLHttpRequest === 'undefined' ? undefined : XMLHttpRequest.prototype;
  const originalOpen = prototype?.open;
  const originalSend = prototype?.send;
  const metadata = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  const pending = new WeakMap<XMLHttpRequest, () => void>();
  let wrappedOpen: typeof XMLHttpRequest.prototype.open | undefined;
  let wrappedSend: typeof XMLHttpRequest.prototype.send | undefined;
  if (prototype && originalOpen && originalSend) {
    wrappedOpen = (function (this: XMLHttpRequest, ...args: unknown[]): void {
      const result = Reflect.apply(originalOpen, this, args);
      pending.get(this)?.();
      try { metadata.set(this, { method: safeString(args[0]), url: safeString(args[1]) }); }
      catch { /* native open already succeeded */ }
      return result;
    }) as typeof XMLHttpRequest.prototype.open;
    wrappedSend = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>): void {
      if (!clients.size) return Reflect.apply(originalSend, this, args);
      const details = metadata.get(this);
      if (!details) return Reflect.apply(originalSend, this, args);
      const started = now();
      let aborted = false;
      let failed = false;
      let completed = false;
      const onAbort = () => { aborted = true; };
      const onFailure = () => { failed = true; };
      const cleanup = () => {
        this.removeEventListener('abort', onAbort);
        this.removeEventListener('error', onFailure);
        this.removeEventListener('timeout', onFailure);
        this.removeEventListener('loadend', onLoadEnd);
        if (pending.get(this) === cleanup) pending.delete(this);
      };
      const onLoadEnd = () => {
        completed = true;
        cleanup();
        if (aborted) return;
        try {
          const status = this.status;
          if (status === 0 && !failed) {
            for (const client of clients) client.reportZeroStatusCompletion(details.method, details.url, now() - started);
            return;
          }
          for (const client of clients) client.reportNetwork(details.method, details.url,
            status === 0 ? undefined : status, now() - started);
        } catch { /* XHR state may be unavailable */ }
      };
      try {
        this.addEventListener('abort', onAbort);
        this.addEventListener('error', onFailure);
        this.addEventListener('timeout', onFailure);
        this.addEventListener('loadend', onLoadEnd);
      } catch {
        cleanup();
        return Reflect.apply(originalSend, this, args);
      }
      try {
        const result = Reflect.apply(originalSend, this, args);
        if (!completed) pending.set(this, cleanup);
        return result;
      }
      catch (error) {
        cleanup();
        throw error;
      }
    };
    prototype.open = wrappedOpen!;
    prototype.send = wrappedSend;
  }
  return {
    clients,
    cleanup() {
      if (wrappedFetch && window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (prototype && wrappedOpen && prototype.open === wrappedOpen) prototype.open = originalOpen!;
      if (prototype && wrappedSend && prototype.send === wrappedSend) prototype.send = originalSend!;
    },
  };
}

function addConsoleClient(client: Client): void {
  if (!consoleInstrumentation) consoleInstrumentation = installConsole();
  consoleInstrumentation.clients.add(client);
}

function removeConsoleClient(client: Client): void {
  const instrumentation = consoleInstrumentation;
  if (!instrumentation) return;
  instrumentation.clients.delete(client);
  if (!instrumentation.clients.size) {
    instrumentation.cleanup();
    consoleInstrumentation = undefined;
  }
}

function installConsole(): Instrumentation {
  const clients = new Set<Client>();
  const original = console.error;
  const wrapped: typeof console.error = function (this: Console, ...values: unknown[]): void {
    try { return Reflect.apply(original, this, values); }
    finally { for (const client of clients) client.captureConsole(values); }
  };
  console.error = wrapped;
  return { clients, cleanup() { if (console.error === wrapped) console.error = original; } };
}

export function init(options: BrowserErrorLogOptions): BrowserErrorLogReferenceClient {
  return new Client(options);
}
