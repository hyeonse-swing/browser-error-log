import { useId, useState } from 'react';
import { EVENT_LABELS, type ErrorEventRecord, type EventType } from 'browser-error-log-protocol';
import type { Analytics, Breakdown } from './analytics';
import './charts.css';

const eventTypes = Object.keys(EVENT_LABELS) as EventType[];
const typeColors: Record<EventType, string> = {
  javascript: '#2563eb', promise: '#7c3aed', react: '#0d9488',
  console: '#525252', http: '#ea580c', network: '#dc2626', manual: '#a3a3a3',
};
const countText = (count: number) => count.toLocaleString('en-US');
const dateText = (value: number | string, withDate = false) => new Intl.DateTimeFormat('en-US', {
  month: withDate ? '2-digit' : undefined, day: withDate ? '2-digit' : undefined,
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));
const intervalText = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} sec` :
  ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` :
    ms < 86_400_000 ? `${Math.round(ms / 3_600_000)} hr` : `${Math.round(ms / 86_400_000)} day`;

function CardHeading({ index, title, note }: { index: string; title: string; note?: string }) {
  return <div className="chart-heading"><div><span className="chart-index">{index}</span><h3>{title}</h3></div>{note && <span className="chart-heading-note">{note}</span>}</div>;
}

function TrendChart({ data }: { data: Analytics }) {
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const buckets = data.trend;
  const width = 960;
  const left = 36;
  const right = 8;
  const top = 12;
  const baseline = 174;
  const plotWidth = width - left - right;
  const plotHeight = baseline - top;
  const peak = Math.max(3, Math.ceil(Math.max(1, ...buckets.map((bucket) => bucket.count)) / 3) * 3);
  const step = buckets.length ? plotWidth / buckets.length : plotWidth;
  const barWidth = Math.max(1, Math.min(24, step * .72));
  const selected = active === null ? null : buckets[active];
  const ticks = [0, 1, 2, 3].map((index) => ({ y: baseline - plotHeight * index / 3, value: Math.round(peak * index / 3) }));

  return <section className="chart-card chart-timeline" aria-labelledby={titleId}>
    <div className="chart-heading"><div><span className="chart-index">01 / TREND</span><h3 id={titleId}>Error trend</h3></div><span className="chart-heading-note">{intervalText(data.intervalMs)}  intervals · browser local time</span></div>
    <div className="chart-legend">{eventTypes.map(type => <span key={type}><i style={{ background: typeColors[type] }}/>{EVENT_LABELS[type]}</span>)}</div>
    {buckets.length === 0 || (data.total === 0 && data.from === 0 && data.to === 0) ? <p className="chart-empty">No errors to show over time.</p> : <>
      <div className="chart-svg-wrap">
        <svg className="chart-svg" viewBox={`0 0 ${width} 210`} aria-labelledby={titleId} preserveAspectRatio="none" onMouseLeave={() => setActive(null)}>
          {ticks.map(({ y, value }, index) => <g key={index}><line x1={left} y1={y} x2={width - right} y2={y} className="chart-grid-line"/><text x={left - 8} y={y + 4} textAnchor="end" className="chart-axis-text">{value}</text></g>)}
          {buckets.map((bucket, index) => {
            const x = left + index * step + (step - barWidth) / 2;
            let stackBottom = baseline;
            const label = `${dateText(bucket.from, true)}–${dateText(bucket.to, true)}, ${countText(bucket.count)} ${bucket.count === 1 ? 'error' : 'errors'}`;
            return <g key={`${bucket.from}-${bucket.to}`} tabIndex={0} role="group" aria-label={label}
              onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)}>
              <title>{label}</title>
              {eventTypes.map((type) => {
                const count = bucket.types[type] ?? 0;
                const height = count / peak * plotHeight;
                stackBottom -= height;
                return count > 0 ? <rect key={type} x={x} y={stackBottom} width={barWidth} height={height} fill={typeColors[type]} rx="1"/> : null;
              })}
              {bucket.count === 0 && <line x1={x} x2={x + barWidth} y1={baseline - 1} y2={baseline - 1} className="chart-zero-mark"/>}
              <rect x={left + index * step} y={top} width={step} height={baseline - top + 8} fill="transparent"/>
            </g>;
          })}
          {[0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].filter((index, position, list) => list.indexOf(index) === position).map((index) =>
            <text key={index} x={left + (index + .5) * step} y="201" textAnchor={index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'} className="chart-axis-text">{dateText(buckets[index].from, true)}</text>)}
        </svg>
      </div>
      <div className="chart-trend-detail" aria-live="polite">{selected ? <><strong>{dateText(selected.from, true)} – {dateText(selected.to, true)}</strong><span>{countText(selected.count)} {selected.count === 1 ? 'event' : 'events'}</span><span className="chart-trend-types">{eventTypes.filter((type) => selected.types[type]).map((type) => `${EVENT_LABELS[type]} ${countText(selected.types[type])}`).join(' · ') || 'No events'}</span></> : <span>Hover over a bar or use the keyboard to see counts by interval.</span>}</div>
      <details className="chart-data-details"><summary>Counts by time interval</summary><div className="chart-table-scroll"><table><thead><tr><th scope="col">Time interval</th><th scope="col">Total</th>{eventTypes.map((type) => <th scope="col" key={type}>{EVENT_LABELS[type]}</th>)}</tr></thead><tbody>{buckets.map((bucket) => <tr key={`${bucket.from}-${bucket.to}`}><th scope="row">{dateText(bucket.from, true)} – {dateText(bucket.to, true)}</th><td>{countText(bucket.count)}</td>{eventTypes.map((type) => <td key={type}>{countText(bucket.types[type] ?? 0)}</td>)}</tr>)}</tbody></table></div></details>
    </>}
  </section>;
}

function RankCard({ index, title, items, empty }: { index: string; title: string; items: Breakdown[]; empty?: string }) {
  const visible = [...items].filter((item) => item.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);
  const max = Math.max(1, ...visible.map((item) => item.count));
  const omittedCount = items.reduce((sum, item) => sum + item.count, 0) - visible.reduce((sum, item) => sum + item.count, 0);
  return <section className="chart-card chart-rank"><CardHeading index={index} title={title} note={items.length > 6 ? `Top 6 of ${items.length} items` : undefined}/>{visible.length ?
    <ol className="chart-rank-list">{visible.map((item) => <li key={item.key} title={item.label}><div className="chart-rank-line"><span className="chart-rank-label">{item.label}</span><strong>{countText(item.count)}</strong></div><span className="chart-rank-track"><span style={{ width: `${item.count / max * 100}%` }}/></span></li>)}</ol> :
    <p className="chart-empty">{empty ?? 'No events in this period.'}</p>}{omittedCount > 0 && <p className="chart-omitted">Other {items.length - visible.length} {items.length - visible.length === 1 ? 'item' : 'items'} · {countText(omittedCount)} {omittedCount === 1 ? 'event' : 'events'}</p>}</section>;
}

function TypeCard({ data }: { data: Breakdown[] }) {
  const entries = data.filter((item) => item.count > 0);
  const total = entries.reduce((sum, item) => sum + item.count, 0);
  let angle = 0;
  const gradient = entries.map((entry) => {
    const start = angle;
    angle += entry.count / total * 100;
    return `${typeColors[entry.key as EventType] ?? '#a3a3a3'} ${start}% ${angle}%`;
  }).join(', ');
  return <section className="chart-card chart-types"><CardHeading index="02 / TYPES" title="Error types"/>{entries.length ? <div className="chart-types-body">
    <div className="chart-donut" style={{ background: `conic-gradient(${gradient})` }} role="img" aria-label={`Error type distribution, total ${countText(total)} ${total === 1 ? 'event' : 'events'}`}><div><strong>{countText(total)}</strong><span> {total === 1 ? 'event' : 'events'}</span></div></div>
    <ul className="chart-type-list">{entries.map((entry) => <li key={entry.key}><span className="chart-type-name"><i style={{ background: typeColors[entry.key as EventType] ?? '#a3a3a3' }}/>{entry.label}</span><strong>{countText(entry.count)}</strong></li>)}</ul>
  </div> : <p className="chart-empty">No errors in this period.</p>}</section>;
}

export function AnalyticsCharts({ data, onSelectError }: { data: Analytics; onSelectError?: (event: ErrorEventRecord) => void }) {
  const metrics = [
    { label: data.total === 1 ? 'Captured error' : 'Captured errors', value: data.total, note: 'Events in the selected period' },
    { label: data.uniqueErrors === 1 ? 'Unique error message' : 'Unique error messages', value: data.uniqueErrors, note: 'By project, type, and message' },
    { label: data.networkErrors === 1 ? 'Network error' : 'Network errors', value: data.networkErrors, note: 'HTTP errors + connection failures' },
    { label: 'Projects', value: data.projectsCount, note: 'Projects with events' },
  ];
  return <div className="chart-dashboard">
    <div className="chart-metrics" aria-label="Captured event summary">{metrics.map((metric) => <div className="chart-metric chart-card" key={metric.label}><span>{metric.label}</span><strong>{countText(metric.value)}</strong><small>{metric.note}</small></div>)}</div>
    <div className="chart-layout">
      <TrendChart data={data}/>
      <TypeCard data={data.types}/>
      <RankCard index="03 / PROJECTS" title="By project" items={data.projects}/>
      <RankCard index="04 / ENVIRONMENTS" title="By environment" items={data.environments}/>
      <RankCard index="05 / RELEASES" title="By release" items={data.releases}/>
      <RankCard index="06 / PAGES" title="By page" items={data.pages}/>
      <RankCard index="07 / RUNTIMES" title="By runtime" items={data.runtimes}/>
      <RankCard index="08 / HTTP STATUS" title="HTTP status codes" items={data.httpStatuses} empty="No HTTP errors with a status code."/>
      <section className="chart-card chart-top-errors"><div className="chart-heading"><div><span className="chart-index">09 / TOP ERRORS</span><h3>Top errors</h3></div><span className="chart-heading-note">Grouped by project, type, and message · up to 8</span></div>
        {data.topErrors.length ? <ol className="chart-error-list">{[...data.topErrors].sort((a, b) => b.count - a.count).slice(0, 8).map((error, index) => <li key={error.key}><button type="button" onClick={() => onSelectError?.(error.event)} disabled={!onSelectError} aria-label={`${error.message}, ${countText(error.count)} ${error.count === 1 ? 'event' : 'events'}, View details`}><span className="chart-error-rank">{String(index + 1).padStart(2, '0')}</span><span className="chart-error-main"><strong title={error.message}>{error.message}</strong><small>{error.project} · {EVENT_LABELS[error.type]} · Last occurred {dateText(error.lastOccurredAt, true)}</small></span><span className="chart-error-count">{countText(error.count)}<small> {error.count === 1 ? 'event' : 'events'}</small></span><span className="chart-error-arrow" aria-hidden="true">↗</span></button></li>)}</ol> : <p className="chart-empty">No errors in this period.</p>}
      </section>
    </div>
  </div>;
}
