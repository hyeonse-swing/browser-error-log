import type { ErrorEventRecord, EventBatch, EventType, Runtime } from '@browser-error-log/protocol';

export type { ErrorEventRecord, EventBatch } from '@browser-error-log/protocol';

export interface CaptureExtra {
  type?: EventType;
  context?: Record<string, unknown>;
  componentStack?: string;
}

export interface TransportContext { signal: AbortSignal }

export interface BrowserErrorLogOptions {
  project: string;
  environment?: string;
  release?: string;
  endpoint?: string;
  transport?: (batch: EventBatch, context: TransportContext) => void | Promise<void>;
  runtime?: Runtime;
  enabled?: boolean;
  captureConsole?: boolean;
  /** Defaults to true. With a custom transport, automatic network capture requires endpoint for collector exclusion. */
  captureNetwork?: boolean;
  beforeSend?: (event: ErrorEventRecord) => ErrorEventRecord | false | null | void;
  sanitizeUrl?: (url: string) => string;
  shouldCaptureHttp?: (status: number, url: string, method: string) => boolean;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  /** Per-attempt deadline, clamped to 250–60000 ms; defaults to 5000 ms. */
  transportTimeoutMs?: number;
}

export interface BrowserErrorLogClient {
  captureException(error: unknown, extra?: CaptureExtra): void;
  flush(): Promise<void>;
  destroy(): void;
  getStats(): { queued: number; sent: number; dropped: number };
}

const MAX_BATCH_EVENTS = 20;
const MAX_BATCH_BYTES = 48_000;
const MAX_BEACON_EVENTS = 10;
const MAX_BEACON_BYTES = 24_000;
const RETRY_DELAYS_MS = [250, 500];
const SENSITIVE_KEY = /(?:password|passwd|token|secret|authorization|cookie|session|api.?key|credential|bearer|private.?key)/i;
const EVENT_TYPES = new Set<EventType>(['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual']);
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

function errorFields(error: unknown): { message: string; name?: string; stack?: string } {
  if (error === null || error === undefined) return { message: 'Unknown error' };
  const message = read(error, 'message');
  const name = read(error, 'name');
  const stack = read(error, 'stack');
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

class HttpDeliveryError extends Error {
  constructor(readonly status: number) { super(`Collector responded ${status}`); }
}

class UrlSanitizationError extends Error {}

class Client implements BrowserErrorLogClient {
  private readonly active: boolean;
  private readonly endpoint?: string;
  private readonly options: BrowserErrorLogOptions;
  private readonly networkCaptureEnabled: boolean;
  private readonly transportTimeoutMs: number;
  private readonly startedAt = now();
  private readonly viewId = newId();
  private readonly seenErrors = new WeakSet<object>();
  private readonly queue: ErrorEventRecord[] = [];
  private readonly maxQueueSize: number;
  private readonly cancelWaits = new Set<() => void>();
  private readonly controllers = new Set<AbortController>();
  private readonly destroySignal: Promise<symbol>;
  private resolveDestroy!: (value: symbol) => void;
  private interval?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private sequence = 0;
  private inFlight = 0;
  private sent = 0;
  private dropped = 0;
  private destroyed = false;

  constructor(options: BrowserErrorLogOptions) {
    this.options = options;
    this.active = options.enabled !== false && typeof window !== 'undefined' && typeof document !== 'undefined';
    this.networkCaptureEnabled = options.captureNetwork !== false && (!options.transport || Boolean(options.endpoint));
    this.maxQueueSize = boundedNumber(options.maxQueueSize, 1, 100, 50);
    this.transportTimeoutMs = boundedNumber(options.transportTimeoutMs, 250, 60_000, 5_000);
    this.destroySignal = new Promise(resolve => { this.resolveDestroy = resolve; });
    if (!this.active) return;
    if (!options.project || typeof options.project !== 'string') throw new Error('project is required');
    if (!options.transport && !options.endpoint) throw new Error('endpoint or transport is required');
    this.endpoint = options.endpoint ? this.absoluteUrl(options.endpoint) : undefined;
    window.addEventListener('error', this.onError);
    window.addEventListener('unhandledrejection', this.onRejection);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (this.networkCaptureEnabled) addNetworkClient(this);
    if (options.captureConsole === true) addConsoleClient(this);
    this.interval = setInterval(() => { void this.flush(); }, boundedNumber(options.flushIntervalMs, 10, 60_000, 10_000));
  }

  captureException(error: unknown, extra: CaptureExtra = {}): void {
    if (!this.active || this.destroyed || isAbort(error)) return;
    try {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        if (this.seenErrors.has(error)) return;
      }
      const fields = errorFields(error);
      const type = EVENT_TYPES.has(extra.type as EventType) ? extra.type! : 'manual';
      const event = this.makeEvent(type, fields.message, {
        name: fields.name,
        stack: fields.stack,
        componentStack: extra.componentStack,
        context: extra.context,
      });
      if (this.enqueue(event) && error !== null && (typeof error === 'object' || typeof error === 'function')) {
        this.seenErrors.add(error);
      }
    } catch (error) {
      if (error instanceof UrlSanitizationError) this.dropped++;
      // Diagnostics must never affect the host app.
    }
  }

  reportNetwork(method: string, url: string, status: number | undefined, durationMs: number, failure?: unknown): void {
    if (this.destroyed || !this.active || this.isCollectorUrl(url) || isAbort(failure)) return;
    try {
      if (status !== undefined) {
        const include = this.options.shouldCaptureHttp
          ? this.options.shouldCaptureHttp(status, url, method)
          : status >= 500;
        if (!include) return;
      }
      const network = { method: trim(method || 'GET', 16).toUpperCase(), url, status, durationMs };
      const fields = failure === undefined ? undefined : errorFields(failure);
      const event = this.makeEvent(status === undefined ? 'network' : 'http',
        status === undefined ? (fields?.message || 'Network request failed') : `HTTP ${status}`,
        { name: fields?.name, network });
      this.enqueue(event);
    } catch { this.dropped++; /* a failing hook must not expose an unfiltered event */ }
  }

  captureConsole(values: unknown[]): void {
    if (!this.active || this.destroyed) return;
    try { this.enqueue(this.makeEvent('console', values.map(safeString).join(' '))); }
    catch { this.dropped++; /* console behavior is never changed by capture */ }
  }

  flush(): Promise<void> {
    if (!this.active || this.destroyed) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.interval) clearInterval(this.interval);
    if (this.active) {
      window.removeEventListener('error', this.onError);
      window.removeEventListener('unhandledrejection', this.onRejection);
      document.removeEventListener('visibilitychange', this.onVisibility);
      if (this.networkCaptureEnabled) removeNetworkClient(this);
      if (this.options.captureConsole === true) removeConsoleClient(this);
    }
    this.dropped += this.queue.length + this.inFlight;
    this.queue.length = 0;
    for (const cancel of this.cancelWaits) cancel();
    for (const controller of this.controllers) controller.abort();
    this.resolveDestroy(DESTROYED);
  }

  getStats(): { queued: number; sent: number; dropped: number } {
    return { queued: this.queue.length, sent: this.sent, dropped: this.dropped };
  }

  private readonly onError = (event: ErrorEvent): void => {
    this.captureException(event.error ?? event.message ?? 'Script error', { type: 'javascript' });
  };

  private readonly onRejection = (event: PromiseRejectionEvent): void => {
    this.captureException(event.reason, { type: 'promise' });
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.tryBeacon();
  };

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

  private cleanText(input: unknown, length: number, replaceUrls = true): string {
    let value = safeString(input);
    if (replaceUrls) {
      value = value.replace(/https?:\/\/[^\s<>"'()[\]]+/gi, match => this.cleanUrl(match));
    }
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
      .slice(0, length);
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
    const context = this.cleanContext(extra.context);
    const network = this.cleanNetwork(extra.network);
    return {
      schemaVersion: 1,
      eventId: newId(),
      project: this.cleanText(this.options.project, 80),
      environment: this.cleanText(this.options.environment ?? 'development', 80),
      release: this.cleanText(this.options.release ?? 'unknown', 120),
      sdkVersion: '0.1.0',
      occurredAt: new Date().toISOString(),
      viewId: this.viewId,
      sequence: ++this.sequence,
      elapsedMs: boundedNumber(now() - this.startedAt, 0, 3_600_000, 0),
      type,
      message: this.cleanText(message, 1024),
      ...(extra.name === undefined ? {} : { name: this.cleanText(extra.name, 100) }),
      ...(extra.stack === undefined ? {} : { stack: this.cleanText(extra.stack, 4096) }),
      ...(extra.componentStack === undefined ? {} : { componentStack: this.cleanText(extra.componentStack, 2048) }),
      page: this.cleanUrl(window.location.href),
      runtime: RUNTIMES.has(this.options.runtime as Runtime) ? this.options.runtime! : 'browser',
      ...(typeof userAgent === 'string' ? { browser: this.cleanText(userAgent, 300) } : {}),
      ...(context ? { context } : {}),
      ...(network ? { network } : {}),
    };
  }

  private sanitizeReplacement(candidate: unknown, base: ErrorEventRecord): ErrorEventRecord {
    const type = read(candidate, 'type');
    const runtime = read(candidate, 'runtime');
    const name = read(candidate, 'name');
    const stack = read(candidate, 'stack');
    const componentStack = read(candidate, 'componentStack');
    const browser = read(candidate, 'browser');
    const context = this.cleanContext(read(candidate, 'context'));
    const network = this.cleanNetwork(read(candidate, 'network'));
    return {
      ...base,
      type: EVENT_TYPES.has(type as EventType) ? type as EventType : base.type,
      message: this.cleanText(read(candidate, 'message') ?? base.message, 1024),
      ...(name === undefined ? { name: base.name } : { name: this.cleanText(name, 100) }),
      ...(stack === undefined ? { stack: base.stack } : { stack: this.cleanText(stack, 4096) }),
      ...(componentStack === undefined ? { componentStack: base.componentStack } : { componentStack: this.cleanText(componentStack, 2048) }),
      page: this.cleanUrl(read(candidate, 'page') ?? base.page),
      runtime: RUNTIMES.has(runtime as Runtime) ? runtime as Runtime : base.runtime,
      ...(browser === undefined ? { browser: base.browser } : { browser: this.cleanText(browser, 300) }),
      ...(context ? { context } : { context: undefined }),
      ...(network ? { network } : { network: undefined }),
    };
  }

  private enqueue(event: ErrorEventRecord): boolean {
    if (this.destroyed) return false;
    let finalEvent = event;
    if (this.options.beforeSend) {
      try {
        const copy = { ...event, context: event.context && { ...event.context }, network: event.network && { ...event.network } };
        const result = this.options.beforeSend(copy);
        if (result === false || result === null) return false;
        finalEvent = this.sanitizeReplacement(result === undefined ? copy : result, event);
      } catch { this.dropped++; return false; }
    }
    // A single event can never make a batch exceed its byte budget.
    if (byteLength(JSON.stringify(finalEvent)) > MAX_BATCH_BYTES) { this.dropped++; return false; }
    if (this.queue.length >= this.maxQueueSize) { this.queue.shift(); this.dropped++; }
    this.queue.push(finalEvent);
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
      if (!events.length && bytes + size > maxBytes) { this.queue.shift(); this.dropped++; continue; }
      events.push(this.queue.shift()!);
      bytes += size;
    }
    return { schemaVersion: 1, events };
  }

  private async drain(): Promise<void> {
    while (!this.destroyed && this.queue.length) {
      const batch = this.takeBatch();
      if (batch.events.length) {
        this.inFlight += batch.events.length;
        try { await this.sendWithRetry(batch); }
        finally { this.inFlight -= batch.events.length; }
      }
    }
  }

  private async sendWithRetry(batch: EventBatch): Promise<void> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length && !this.destroyed; attempt++) {
      const controller = new AbortController();
      this.controllers.add(controller);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error('Collector transport timed out'));
        }, this.transportTimeoutMs);
      });
      let retryDelay: number | undefined;
      try {
        const result = await Promise.race([this.send(batch, controller.signal), timeout, this.destroySignal]);
        if (result === DESTROYED || this.destroyed) return;
        this.sent += batch.events.length;
        return;
      } catch (error) {
        if (this.destroyed) return;
        const status = read(error, 'status');
        const retryable = typeof status !== 'number' || status === 429 || status >= 500;
        if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
        retryDelay = RETRY_DELAYS_MS[attempt];
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.controllers.delete(controller);
      }
      if (retryDelay !== undefined) await this.wait(retryDelay);
    }
    if (!this.destroyed) this.dropped += batch.events.length;
  }

  private async send(batch: EventBatch, signal: AbortSignal): Promise<void> {
    if (this.options.transport) { await this.options.transport(batch, { signal }); return; }
    const response = await window.fetch(this.endpoint!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      credentials: 'omit',
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

  private tryBeacon(): void {
    if (this.destroyed || this.options.transport || !this.endpoint || !this.queue.length) return;
    try {
      const url = new URL(this.endpoint);
      if (url.origin !== window.location.origin || url.search || url.hash || url.username || url.password) return;
      if (typeof navigator.sendBeacon !== 'function') return;
      const candidates = this.queue.slice(0, MAX_BEACON_EVENTS);
      while (candidates.length > 0) {
        const batch: EventBatch = { schemaVersion: 1, events: candidates };
        const body = JSON.stringify(batch);
        if (byteLength(body) <= MAX_BEACON_BYTES) {
          if (navigator.sendBeacon(this.endpoint, new Blob([body], { type: 'application/json' }))) {
            this.queue.splice(0, candidates.length);
          }
          return;
        }
        candidates.pop();
      }
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
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
  const url = request ? request.url : safeString(input);
  return { url, method: safeString(init?.method ?? request?.method ?? 'GET'), signal: init?.signal ?? request?.signal };
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
  let wrappedOpen: typeof XMLHttpRequest.prototype.open | undefined;
  let wrappedSend: typeof XMLHttpRequest.prototype.send | undefined;
  if (prototype && originalOpen && originalSend) {
    wrappedOpen = (function (this: XMLHttpRequest, ...args: unknown[]): void {
      const result = Reflect.apply(originalOpen, this, args);
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
      const onAbort = () => { aborted = true; };
      const onFailure = () => { failed = true; };
      const onLoadEnd = () => {
        this.removeEventListener('abort', onAbort);
        this.removeEventListener('error', onFailure);
        this.removeEventListener('timeout', onFailure);
        this.removeEventListener('loadend', onLoadEnd);
        if (aborted) return;
        try {
          const status = this.status;
          if (status === 0 && !failed) return;
          for (const client of clients) client.reportNetwork(details.method, details.url,
            status === 0 ? undefined : status, now() - started);
        } catch { /* XHR state may be unavailable */ }
      };
      try {
        this.addEventListener('abort', onAbort);
        this.addEventListener('error', onFailure);
        this.addEventListener('timeout', onFailure);
        this.addEventListener('loadend', onLoadEnd);
      } catch { return Reflect.apply(originalSend, this, args); }
      try { return Reflect.apply(originalSend, this, args); }
      catch (error) {
        this.removeEventListener('abort', onAbort);
        this.removeEventListener('error', onFailure);
        this.removeEventListener('timeout', onFailure);
        this.removeEventListener('loadend', onLoadEnd);
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

export function init(options: BrowserErrorLogOptions): BrowserErrorLogClient {
  return new Client(options);
}
