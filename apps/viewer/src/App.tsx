import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EVENT_LABELS, type ErrorEventRecord, type EventFilter, type EventType } from 'browser-error-log-protocol';
import { eventDataSource, viewerConfig } from './data-source';
import { Dashboard } from './Dashboard';
import { LanguageSwitcher, useLocale } from '../../i18n/react';
import { eventLabel, localizeError, numberText, t } from './i18n';
import type { Locale } from '../../i18n/locale';

type TimeRange = '24h' | '7d' | 'all';
const eventTypes = Object.keys(EVENT_LABELS) as EventType[];
const timeRanges: { value: TimeRange; label: string }[] = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'all', label: 'All time' },
];

function Icon({ name, size = 18 }: { name: 'refresh' | 'search' | 'chevron' | 'copy' | 'arrow' | 'close' | 'external'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths = {
    refresh: <><path d="M20 11a8 8 0 1 0-2.4 6.1"/><path d="M20 4v7h-7"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.2 4.2"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
    arrow: <path d="M18 12H6m6-6-6 6 6 6"/>,
    close: <path d="M5 5 19 19M19 5 5 19"/>,
    external: <><path d="M13 5h6v6M19 5l-9 9"/><path d="M18 14v5H5V6h5"/></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function formatDate(value: string, locale: Locale, withYear = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', {
    year: withYear ? 'numeric' : undefined,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return locale === 'ko'
    ? `${withYear ? `${get('year')}.` : ''}${get('month')}.${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
    : `${get('month')}/${get('day')}${withYear ? `/${get('year')}` : ''} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function rangeStart(range: TimeRange) {
  if (range === 'all') return undefined;
  return new Date(Date.now() - (range === '24h' ? 24 : 7 * 24) * 60 * 60 * 1000).toISOString();
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'An unknown error occurred.';
}

function newestFirst(events: ErrorEventRecord[]) {
  return [...events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)
    || b.eventId.localeCompare(a.eventId) || b.project.localeCompare(a.project));
}

function eventKey(event: Pick<ErrorEventRecord, 'project' | 'eventId'>) {
  return JSON.stringify([event.project, event.eventId]);
}

export function App() {
  const locale = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = viewerConfig.title || t(locale, 'Browser Error Log');
  }, [locale]);
  const [activeView, setActiveView] = useState<'dashboard' | 'events'>('dashboard');
  const [project, setProject] = useState('');
  const [environment, setEnvironment] = useState('');
  const [type, setType] = useState<EventType | ''>('');
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [events, setEvents] = useState<ErrorEventRecord[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState('');
  const [listErrorSource, setListErrorSource] = useState<'list' | 'more'>('list');
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<ErrorEventRecord | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [copyState, setCopyState] = useState('');
  const [knownProjects, setKnownProjects] = useState<string[]>([]);
  const [knownEnvironments, setKnownEnvironments] = useState<string[]>([]);
  const loadMoreController = useRef<AbortController | null>(null);
  const previousCriteria = useRef<string | undefined>(undefined);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!autoRefresh || activeView !== 'events') return;
    const timer = window.setInterval(() => setRefreshToken((current) => current + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, activeView]);

  const filter = useMemo<EventFilter>(() => ({
    project: project.trim() || undefined,
    environment: environment.trim() || undefined,
    type: type || undefined,
    query: query || undefined,
    from: rangeStart(timeRange),
    limit: 30,
  }), [project, environment, type, query, timeRange, refreshToken, activeView]);

  useEffect(() => {
    loadMoreController.current?.abort();
    setLoadingMore(false);
    if (activeView !== 'events') return;
    const controller = new AbortController();
    const criteria = JSON.stringify([project, environment, type, query, timeRange]);
    if (previousCriteria.current !== criteria) {
      setEvents([]);
      setCursor(undefined);
      setSelectedId(undefined);
    }
    previousCriteria.current = criteria;
    setLoading(true);
    setListError('');
    eventDataSource.listEvents(filter, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      const ordered = newestFirst(page.events);
      setEvents(ordered);
      setCursor(page.nextCursor);
      setSelectedId((current) => ordered.some((event) => eventKey(event) === current) ? current : ordered[0] && eventKey(ordered[0]));
      setKnownProjects((current) => [...new Set([...current, ...page.events.map((event) => event.project)])].sort());
      setKnownEnvironments((current) => [...new Set([...current, ...page.events.map((event) => event.environment)])].sort());
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !isAbort(error)) {
        setListErrorSource('list');
        setListError(events.length > 0 ? `Refresh failed · showing previous results: ${errorMessage(error)}` : errorMessage(error));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [filter, project, environment, type, query, timeRange, activeView]);

  useEffect(() => {
    if (activeView !== 'events') return;
    if (!selectedId) {
      setSelected(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError('');
    setSelected(events.find((event) => eventKey(event) === selectedId) ?? null);
    const [selectedProject, selectedEventId] = JSON.parse(selectedId) as [string, string];
    eventDataSource.getEvent(selectedProject, selectedEventId, controller.signal).then((event) => {
      if (controller.signal.aborted) return;
      setSelected(event);
      if (!event) setDetailError('This event could not be found.');
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !isAbort(error)) setDetailError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false);
    });
    return () => controller.abort();
  }, [selectedId, refreshToken, activeView]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setListError('');
    try {
      const page = await eventDataSource.listEvents({ ...filter, cursor }, controller.signal);
      if (controller.signal.aborted) return;
      setEvents((current) => {
        const seen = new Set(current.map(eventKey));
        return newestFirst([...current, ...page.events.filter((event) => !seen.has(eventKey(event)))]);
      });
      setCursor(page.nextCursor);
      setKnownProjects((current) => [...new Set([...current, ...page.events.map((event) => event.project)])].sort());
      setKnownEnvironments((current) => [...new Set([...current, ...page.events.map((event) => event.environment)])].sort());
    } catch (error) {
      if (!controller.signal.aborted && !isAbort(error)) {
        setListErrorSource('more');
        setListError(`Could not load older events: ${errorMessage(error)}`);
      }
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [cursor, filter, loadingMore]);

  async function copyEvent() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
      setCopyState('Copied');
    } catch {
      setCopyState('Copy failed');
    }
    window.setTimeout(() => setCopyState(''), 2400);
  }

  const clearFilters = () => {
    setProject(''); setEnvironment(''); setType(''); setTimeRange('24h'); setSearch(''); setQuery('');
  };

  const title = viewerConfig.title || t(locale, 'Browser Error Log');
  const localMode = viewerConfig.mode !== 'live';
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><i/><i/><i/></span><div><div className="brand-overline">{t(locale, 'BROWSER / LOG')}</div><div className="brand-title">{title}</div></div></div>
      <div className="side-section-label">{t(locale, 'WORKSPACE')} <span>01</span></div>
      <nav className="side-navigation" aria-label={t(locale, 'Monitoring navigation')}>{([{ value: 'dashboard', label: 'Error Dashboard' }, { value: 'events', label: 'Event Timeline' }] as const).map(view => <button key={view.value} type="button" className={activeView === view.value ? 'side-active' : 'side-inactive'} aria-current={activeView === view.value ? 'page' : undefined} onClick={() => setActiveView(view.value)}><span className="side-active-dot"/>{t(locale, view.label)}</button>)}</nav>
      <div className="side-bottom"><div className="side-rule"/><div className="side-bottom-heading">{t(locale, 'Test Tools')}</div><a href="/demo.html" className="demo-link">{t(locale, 'Trigger Errors')} <Icon name="external" size={15}/></a><p>{t(locale, 'Trigger errors in the browser and inspect the capture flow.')}</p><div className="side-version">{t(locale, 'ERROR LOG')} <span>v0.1</span></div></div>
    </aside>

    <main className="workspace">
      <header className="topbar"><div className="breadcrumb">{t(locale, 'MONITORING')} <span>/</span> {t(locale, activeView === 'dashboard' ? 'OVERVIEW' : 'EVENTS')}</div><div className="topbar-right"><LanguageSwitcher/><span className={`source-dot ${localMode ? 'is-local' : ''}`}/><span>{t(locale, localMode ? 'Local Test' : 'Connected Data Source')}</span></div></header>
      <nav className="view-tabs" aria-label={t(locale, 'Select view')}><button type="button" aria-current={activeView === 'dashboard' ? 'page' : undefined} onClick={() => setActiveView('dashboard')}>{t(locale, 'Dashboard')}</button><button type="button" aria-current={activeView === 'events' ? 'page' : undefined} onClick={() => setActiveView('events')}>{t(locale, 'Event Timeline')}</button></nav>
      <div hidden={activeView !== 'dashboard'}><Dashboard/></div>
      {activeView === 'events' && <>
      <section className="page-head"><div><div className="eyebrow">{t(locale, 'EVENT STREAM')} <span>—</span> 001</div><h1>{title}</h1><p>{t(locale, 'Explore captured browser errors in chronological order.')}</p></div><div className="head-actions"><label className="auto-toggle"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)}/><span className="toggle-track"/>{t(locale, 'Auto-refresh')} <span className="auto-interval">{locale === 'ko' ? '30초' : '30s'}</span></label><button className="refresh-button" onClick={() => setRefreshToken((current) => current + 1)} type="button"><Icon name="refresh" size={16}/> {t(locale, 'Refresh')}</button></div></section>
      {localMode && <div className="local-notice"><span className="notice-icon">i</span><span><strong>{t(locale, 'Local Test')}</strong> · {t(locale, 'Stored in memory; cleared on restart')}</span></div>}

      <section className="filter-bar" aria-label={t(locale, 'Event filters')}>
        <div className="filter-field project-field"><label htmlFor="project">{t(locale, 'Project')}</label><input id="project" list="project-options" placeholder={t(locale, 'All projects')} value={project} onChange={(event) => setProject(event.target.value)}/><datalist id="project-options">{knownProjects.map((name) => <option key={name} value={name}/>)}</datalist></div>
        <div className="filter-field env-field"><label htmlFor="environment">{t(locale, 'Environment')}</label><input id="environment" list="environment-options" placeholder={t(locale, 'All environments')} value={environment} onChange={(event) => setEnvironment(event.target.value)}/><datalist id="environment-options">{knownEnvironments.map((name) => <option key={name} value={name}/>)}</datalist></div>
        <div className="filter-field type-field"><label htmlFor="type">{t(locale, 'Type')}</label><select id="type" value={type} onChange={(event) => setType(event.target.value as EventType | '')}><option value="">{t(locale, 'All types')}</option>{eventTypes.map((value) => <option key={value} value={value}>{eventLabel(locale, value)}</option>)}</select></div>
        <div className="filter-field time-field"><label htmlFor="time-range">{t(locale, 'Time range')}</label><select id="time-range" value={timeRange} onChange={(event) => setTimeRange(event.target.value as TimeRange)}>{timeRanges.map((range) => <option key={range.value} value={range.value}>{t(locale, range.label)}</option>)}</select></div>
        <div className="filter-field search-field"><label htmlFor="search">{t(locale, 'Search')}</label><div className="search-wrap"><Icon name="search" size={16}/><input id="search" type="search" placeholder={t(locale, 'Search message, page, or ID')} value={search} onChange={(event) => setSearch(event.target.value)}/></div></div>
      </section>

      <div className="content-grid"><section className={`event-list ${mobileDetail ? 'mobile-hidden' : ''}`} aria-label={t(locale, 'Event list')}><div className="panel-heading"><div><span className="section-index">{t(locale, '01 / TIMELINE')}</span><h2>{t(locale, 'Event list')}</h2></div><div className="record-count">{events.length}<span>{cursor ? '+' : ''} {locale === 'ko' ? '건' : events.length === 1 && !cursor ? 'record' : 'records'}</span></div></div>
        <div className="list-columns"><span>{t(locale, 'Occurred / type')}</span><span>{t(locale, 'Event')}</span><span>{t(locale, 'Project / environment')}</span></div>
        {loading && <div className="state-box"><span className="loading-mark"/>{t(locale, 'Loading events')}</div>}
        {!loading && listError && events.length === 0 && <div className="state-box state-error"><strong>{t(locale, 'Could not load events')}</strong><span>{localizeError(locale, listError)}</span><button type="button" onClick={() => setRefreshToken((current) => current + 1)}>{t(locale, 'Retry')}</button></div>}
        {!loading && !listError && events.length === 0 && <div className="state-box"><span className="empty-glyph">∅</span><strong>{t(locale, 'No events match your filters')}</strong><span>{t(locale, 'Change the filters or trigger an error.')}</span><button type="button" onClick={clearFilters}>{t(locale, 'Clear filters')}</button></div>}
        {!loading && listError && events.length > 0 && <div className="list-inline-error">{localizeError(locale, listError)}<button type="button" onClick={listErrorSource === 'more' ? loadMore : () => setRefreshToken((current) => current + 1)}>{t(locale, 'Retry')}</button></div>}
        {!loading && events.length > 0 && <div className="rows">{events.map((event, index) => <button type="button" key={eventKey(event)} className={`event-row ${selectedId === eventKey(event) ? 'selected' : ''}`} onClick={() => { setSelectedId(eventKey(event)); setMobileDetail(true); }} style={{ animationDelay: `${Math.min(index, 10) * 25}ms` }}><span className="row-time"><span className="time-value">{formatDate(event.occurredAt, locale)}</span><span className={`type-pill type-${event.type}`}>{eventLabel(locale, event.type)}</span></span><span className="row-main"><strong title={event.message}>{event.message}</strong><small>{event.name && <span>{event.name} <b>·</b> </span>}{event.page}</small></span><span className="row-origin"><strong>{event.project}</strong><small>{event.environment}</small></span><span className="row-chevron"><Icon name="chevron" size={17}/></span></button>)}</div>}
        {!loading && cursor && <button className="load-more" type="button" disabled={loadingMore} onClick={loadMore}>{t(locale, loadingMore ? 'Loading…' : 'Load older events')}<Icon name="chevron" size={16}/></button>}
        {!loading && events.length > 0 && !cursor && <div className="list-end">{t(locale, 'You reached the last event')} <span>{t(locale, '— END OF LOG')}</span></div>}
      </section>

      <section className={`detail-panel ${mobileDetail ? 'mobile-visible' : ''}`} aria-label={t(locale, 'Event details')}><div className="panel-heading detail-heading"><div><span className="section-index">{t(locale, '02 / INSPECTOR')}</span><h2>{t(locale, 'Event details')}</h2></div>{selected && <button className="copy-button" type="button" onClick={copyEvent} title={t(locale, 'Copy event JSON')}><Icon name="copy" size={15}/>{t(locale, copyState || 'Copy JSON')}</button>}</div><button className="mobile-back" type="button" onClick={() => setMobileDetail(false)}><Icon name="arrow" size={17}/> {t(locale, 'Back to list')}</button>
        {!selectedId && <div className="detail-empty"><span className="detail-empty-icon">↗</span><strong>{t(locale, 'Select an event')}</strong><p>{t(locale, 'Select an event from the list to')}<br/>{t(locale, 'see its details here.')}</p></div>}
        {selectedId && detailError && !selected && <div className="state-box state-error"><strong>{t(locale, 'Could not load event details')}</strong><span>{localizeError(locale, detailError)}</span><button type="button" onClick={() => { setSelectedId(undefined); window.setTimeout(() => setSelectedId(selectedId), 0); }}>{t(locale, 'Retry')}</button></div>}
        {selectedId && detailLoading && !selected && <div className="state-box"><span className="loading-mark"/>{t(locale, 'Loading event details')}</div>}
        {selected && <div className="detail-content"><div className="detail-lead"><div className="detail-kind"><span className="error-square">!</span><span>{eventLabel(locale, selected.type)}</span><span className="detail-seq">#{selected.sequence}</span></div><h3>{selected.message}</h3><div className="detail-name">{selected.name || selected.type}</div></div>
          {detailError && <div className="detail-warning">{t(locale, 'Could not refresh event details:')} {localizeError(locale, detailError)}</div>}
          <div className="detail-block"><div className="block-title">{t(locale, 'Occurrence details')} <span>01</span></div><dl className="info-grid"><div><dt>{t(locale, 'Occurred at')}</dt><dd className="mono">{formatDate(selected.occurredAt, locale, true)}</dd></div><div><dt>{t(locale, 'Received at')}</dt><dd className="mono">{selected.receivedAt ? formatDate(selected.receivedAt, locale, true) : '—'}</dd></div><div><dt>{t(locale, 'Project')}</dt><dd>{selected.project}</dd></div><div><dt>{t(locale, 'Environment')}</dt><dd>{selected.environment}</dd></div><div><dt>{t(locale, 'Release')}</dt><dd className="mono">{selected.release || '—'}</dd></div><div><dt>{t(locale, 'Runtime')}</dt><dd>{selected.runtime}</dd></div><div><dt>{t(locale, 'Browser')}</dt><dd>{selected.browser || '—'}</dd></div><div><dt>SDK</dt><dd className="mono">{selected.sdkVersion}</dd></div></dl></div>
          <div className="detail-block"><div className="block-title">{t(locale, 'Location and identifiers')} <span>02</span></div><dl className="info-grid"><div className="wide"><dt>{t(locale, 'Page')}</dt><dd className="breakable">{selected.page}</dd></div><div className="wide"><dt>{t(locale, 'Event ID')}</dt><dd className="mono breakable">{selected.eventId}</dd></div><div><dt>{t(locale, 'View ID')}</dt><dd className="mono breakable">{selected.viewId}</dd></div><div><dt>{t(locale, 'Elapsed time')}</dt><dd className="mono">{numberText(locale, selected.elapsedMs)} ms</dd></div></dl></div>
          {selected.network && <div className="detail-block"><div className="block-title">{t(locale, 'Network')} <span>03</span></div><div className="network-summary"><span className="method-tag">{selected.network.method}</span><span className="network-url">{selected.network.url}</span></div><dl className="info-grid compact"><div><dt>{t(locale, 'HTTP status')}</dt><dd className="mono">{selected.network.status ?? t(locale, 'No response')}</dd></div><div><dt>{t(locale, 'Duration')}</dt><dd className="mono">{numberText(locale, selected.network.durationMs)} ms</dd></div></dl></div>}
          {selected.stack && <div className="detail-block"><div className="block-title">{t(locale, 'Stack trace')}</div><pre className="code-block">{selected.stack}</pre></div>}
          {selected.componentStack && <div className="detail-block"><div className="block-title">{t(locale, 'Component stack')}</div><pre className="code-block">{selected.componentStack}</pre></div>}
          {selected.context && Object.keys(selected.context).length > 0 && <div className="detail-block"><div className="block-title">{t(locale, 'Additional context')}</div><dl className="info-grid context-grid">{Object.entries(selected.context).map(([key, value]) => <div key={key}><dt>{key}</dt><dd className="breakable">{value === null ? 'null' : String(value)}</dd></div>)}</dl></div>}
        </div>}
      </section></div>
      </>}
      <footer className="footer"><span>{t(locale, 'BROWSER / LOG')}</span><span>{t(locale, 'Times are shown in your browser’s local time.')}</span></footer>
    </main>
  </div>;
}
