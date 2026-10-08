import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { EVENT_LABELS, type ErrorEventRecord, type EventFilter, type EventType } from '@browser-error-log/protocol';
import { AnalyticsCharts } from './Charts';
import { buildAnalytics } from './analytics';
import { eventDataSource, viewerConfig } from './data-source';
import { filterHistory, loadHistory, MAX_HISTORY_EVENTS, MAX_IMPORT_BYTES, parseHistoryJson, serializeHistory, type HistoryResult } from './history';
import './dashboard.css';

type Period = '24h' | '7d' | '30d' | 'all' | 'custom';
type Controls = { project: string; environment: string; type: EventType | ''; query: string; period: Period; from: string; to: string };
type Source = { kind: 'api' } | { kind: 'file'; name: string; events: ErrorEventRecord[]; duplicates: number; truncated: boolean };
type Loaded = HistoryResult & { filter: EventFilter; sourceLabel: string; sourceKind: Source['kind']; loadedAt: string };

function localInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function initialControls(): Controls {
  return { project: '', environment: '', type: '', query: '', period: '7d', from: localInput(new Date(Date.now() - 7 * 86400_000)), to: localInput(new Date()) };
}

function toFilter(controls: Controls, source: Source): EventFilter {
  const now = new Date();
  let from: string | undefined;
  let to: string | undefined = source.kind === 'api' ? now.toISOString() : undefined;
  if (controls.period === 'custom') {
    const start = new Date(controls.from).getTime();
    const end = new Date(controls.to).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('Check the start and end times. The start cannot be later than the end.');
    from = new Date(start).toISOString();
    to = new Date(end).toISOString();
  } else if (controls.period !== 'all') {
    const days = controls.period === '24h' ? 1 : controls.period === '7d' ? 7 : 30;
    from = new Date(now.getTime() - days * 86400_000).toISOString();
    to = now.toISOString();
  }
  return { project: controls.project.trim() || undefined, environment: controls.environment.trim() || undefined, type: controls.type || undefined, query: controls.query.trim() || undefined, from, to };
}

const dateLabel = (value: string | number) => new Date(value).toLocaleString('en-US', { hour12: false });
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Could not load data.';

function EventDialog({ event, onClose }: { event: ErrorEventRecord; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="dash-dialog" aria-labelledby="historical-event-title" onCancel={onClose}>
    <header><div><span className="section-index">EVENT DETAIL</span><h2 id="historical-event-title">Representative error event</h2></div><button type="button" onClick={onClose} autoFocus aria-label="Close details">Close ×</button></header>
    <div className="dash-dialog-body">
      <span className={`type-pill type-${event.type}`}>{EVENT_LABELS[event.type]}</span><h3>{event.message}</h3>
      <dl className="dash-detail-grid">
        <div><dt>Occurred at</dt><dd>{dateLabel(event.occurredAt)}</dd></div><div><dt>Received at</dt><dd>{event.receivedAt ? dateLabel(event.receivedAt) : 'No record'}</dd></div>
        <div><dt>Project / environment</dt><dd>{event.project} / {event.environment || 'Unspecified'}</dd></div><div><dt>Release / Runtime</dt><dd>{event.release || 'Unspecified'} / {event.runtime}</dd></div>
        <div><dt>Page</dt><dd>{event.page}</dd></div><div><dt>Event ID</dt><dd>{event.eventId}</dd></div>
      </dl>
      {event.network && <section><h4>Network</h4><p>{event.network.method} {event.network.url}</p><p>Response {event.network.status || 'None'} · {event.network.durationMs.toLocaleString()} ms</p></section>}
      {event.stack && <section><h4>Stack trace</h4><pre className="code-block">{event.stack}</pre></section>}
      {event.componentStack && <section><h4>Component stack</h4><pre className="code-block">{event.componentStack}</pre></section>}
      {event.context && <section><h4>Additional context</h4><pre className="code-block">{JSON.stringify(event.context, null, 2)}</pre></section>}
    </div>
  </dialog>;
}

export function Dashboard() {
  const [controls, setControls] = useState<Controls>(initialControls);
  const [source, setSource] = useState<Source>({ kind: 'api' });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<ErrorEventRecord | null>(null);
  const [knownProjects, setKnownProjects] = useState<string[]>([]);
  const [knownEnvironments, setKnownEnvironments] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const localMode = viewerConfig.mode !== 'live';
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function update<K extends keyof Controls>(key: K, value: Controls[K]) {
    setControls(current => ({ ...current, [key]: value }));
    setDirty(true);
  }

  function remember(events: ErrorEventRecord[]) {
    setKnownProjects(current => [...new Set([...current, ...events.map(event => event.project)])].sort());
    setKnownEnvironments(current => [...new Set([...current, ...events.map(event => event.environment)])].sort());
  }

  async function runQuery(nextControls: Controls, nextSource: Source) {
    controller.current?.abort();
    const current = ++generation.current;
    setLoading(false);
    let filter: EventFilter;
    try { filter = toFilter(nextControls, nextSource); }
    catch (error) { setLoaded(null); setError(messageOf(error)); return; }
    const request = new AbortController();
    controller.current = request;
    setLoading(true); setLoaded(null); setError(''); setProgress(0); setDirty(false); setSelected(null);
    try {
      const result = nextSource.kind === 'api'
        ? await loadHistory(eventDataSource, filter, request.signal, count => { if (current === generation.current) setProgress(count); })
        : { events: filterHistory(nextSource.events, filter), truncated: nextSource.truncated, duplicates: nextSource.duplicates };
      if (current !== generation.current || request.signal.aborted) return;
      setLoaded({ ...result, filter, sourceKind: nextSource.kind, sourceLabel: nextSource.kind === 'api' ? (localMode ? 'Local API' : 'Connected API') : nextSource.name, loadedAt: new Date().toISOString() });
      remember(result.events);
    } catch (error) {
      if (current === generation.current && !request.signal.aborted) setError(messageOf(error));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  useEffect(() => {
    void runQuery(controls, source);
    return () => { generation.current++; controller.current?.abort(); };
  }, []);

  async function importFile(file: File) {
    controller.current?.abort();
    const current = ++generation.current;
    setLoading(true); setProgress(0); setError(''); setSelected(null); setLoaded(null);
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('JSON files must be 10 MiB or smaller. Import a shorter time range.');
      const text = await file.text();
      if (current !== generation.current) return;
      const result = parseHistoryJson(text);
      const nextSource: Source = { kind: 'file', name: file.name, events: result.events, duplicates: result.duplicates, truncated: result.truncated };
      const nextControls: Controls = { ...initialControls(), period: 'all' };
      setSource(nextSource); setControls(nextControls); setDirty(false);
      setKnownProjects([]); setKnownEnvironments([]); remember(result.events);
      setLoaded({ ...result, filter: {}, sourceKind: 'file', sourceLabel: file.name, loadedAt: new Date().toISOString() });
    } catch (error) {
      if (current === generation.current) setError(messageOf(error));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  function switchToApi() {
    const nextSource: Source = { kind: 'api' };
    const nextControls = initialControls();
    setSource(nextSource); setControls(nextControls); setKnownProjects([]); setKnownEnvironments([]);
    void runQuery(nextControls, nextSource);
  }

  function exportJson() {
    if (!loaded) return;
    try {
      const content = serializeHistory(loaded.events, { truncated: loaded.truncated });
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `error-history-${new Date().toISOString().slice(0, 10)}${loaded.truncated ? '-partial' : ''}.json`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError(messageOf(error)); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void runQuery(controls, source); }
  const analytics = useMemo(() => loaded ? buildAnalytics(loaded.events, loaded.filter) : null, [loaded]);
  return <div className="dashboard">
    <section className="dash-heading"><div><span className="eyebrow">ERROR MONITORING / OVERVIEW</span><h1>Error Dashboard</h1><p>See when, where, and which errors increased.</p></div><div className="dash-file-actions">
      <input ref={fileInput} type="file" accept=".json,application/json" className="dash-file-input" aria-label="Historical data JSON file" onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }}/>
      <button className="dash-button" type="button" onClick={() => fileInput.current?.click()}>Import JSON</button><button className="dash-button" type="button" disabled={!loaded?.events.length || loading} onClick={exportJson}>Save query data ↓</button>
    </div></section>

    <div className="dash-source"><span className={`dash-source-badge ${source.kind === 'file' ? 'file' : ''}`}>{source.kind === 'file' ? 'JSON FILE' : 'API SOURCE'}</span><span>{source.kind === 'file' ? source.name : localMode ? 'Local test data · cleared on restart' : 'Connected service data'}</span>{source.kind === 'file' && <button type="button" onClick={switchToApi}>Return to API</button>}</div>
    <form className="dash-filters" onSubmit={submit}>
      <div className="dash-filter-row">
        <label>Project<input list="dash-projects" placeholder="All projects" value={controls.project} onChange={event => update('project', event.target.value)}/><datalist id="dash-projects">{knownProjects.map(value => <option key={value} value={value}/>)}</datalist></label>
        <label>Environment<input list="dash-environments" placeholder="All environments" value={controls.environment} onChange={event => update('environment', event.target.value)}/><datalist id="dash-environments">{knownEnvironments.map(value => <option key={value} value={value}/>)}</datalist></label>
        <label>Error types<select value={controls.type} onChange={event => update('type', event.target.value as Controls['type'])}><option value="">All types</option>{Object.entries(EVENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Query period<select value={controls.period} onChange={event => update('period', event.target.value as Period)}><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All time</option><option value="custom">Custom range</option></select></label>
        <label className="dash-search">Search<input type="search" placeholder="Message, page, release" value={controls.query} onChange={event => update('query', event.target.value)}/></label>
      </div>
      {controls.period === 'custom' && <div className="dash-date-row"><label>Start time<input type="datetime-local" required value={controls.from} onChange={event => update('from', event.target.value)}/></label><span>—</span><label>End time<input type="datetime-local" required value={controls.to} onChange={event => update('to', event.target.value)}/></label><small>{timezone}</small></div>}
      <div className="dash-query-row"><span>{dirty ? 'Filters changed. Run the query to apply them.' : source.kind === 'file' ? 'This file is analyzed in your browser and is not sent to the server.' : 'Load stored events for the selected period.'}</span><button className="dash-button primary" type="submit">{loading ? 'Run again' : 'Query'} ↗</button></div>
    </form>

    {error && <div className="dash-error" role="alert"><strong>Query status</strong><span>{error}</span><button className="dash-button" type="button" onClick={() => void runQuery(controls, source)}>Retry</button></div>}
    {loading && <div className="dash-loading" role="status"><span className="loading-mark"/><strong>Loading events</strong><span>{progress.toLocaleString()} {progress === 1 ? 'event' : 'events'} checked</span><button type="button" onClick={() => { generation.current++; controller.current?.abort(); setLoading(false); setError('Loading was canceled. Run the query to start again.'); }}>Cancel</button></div>}
    {loaded && analytics && <>
      <div className="dash-summary"><span><strong>{loaded.events.length.toLocaleString('en-US')} {loaded.events.length === 1 ? 'event' : 'events'}</strong> · {loaded.sourceLabel} {loaded.duplicates > 0 && `· ${loaded.duplicates.toLocaleString('en-US')} ${loaded.duplicates === 1 ? 'duplicate' : 'duplicates'} excluded`}</span><span>Queried at {dateLabel(loaded.loadedAt)}</span></div>
      <div className="dash-range">{loaded.events.length > 0 || loaded.filter.from ? `${dateLabel(analytics.from)} — ${dateLabel(analytics.to)}` : 'No occurrence time to show'} · {timezone}</div>
      {loaded.truncated && <div className="dash-error" role="status"><strong>Only some events were included</strong><span>{loaded.sourceKind === 'file' ? 'This export contains only some events.' : `The browser query limit (${MAX_HISTORY_EVENTS.toLocaleString()} events or 100 pages) was reached.`} The charts use the events retrieved. Narrow the time range or project and run the query again.</span></div>}
      {loaded.events.length === 0 && <div className="dash-empty"><strong>No errors match the selected filters</strong><p>Change the time range or filters, or import historical JSON.</p></div>}
      <AnalyticsCharts data={analytics} onSelectError={setSelected}/>
      <p className="dash-footnote">These counts exclude duplicate errors. Total requests and visitors are not collected, so they do not represent error rates or affected users.</p>
    </>}
    <details className="dash-help"><summary>How to load historical data</summary><p>The API queries by occurrence time. A connected server must provide persistent storage and history. The development demo keeps up to 2,000 events in memory and clears them on restart.</p><p>Import a file saved from this page, a v1 event array, or a JSON object in the <code>{'{ "schemaVersion": 1, "events": [...] }'}</code> format. The limit is 10 MiB and 10,000 events. Refreshing clears file analysis; import the file again to restore it.</p><a href="/history-example.json" download>Download sample history JSON ↓</a></details>
    {selected && <EventDialog event={selected} onClose={() => setSelected(null)}/>}
  </div>;
}
