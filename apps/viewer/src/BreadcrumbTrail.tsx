import { isBreadcrumbTrail } from '@ihyeon/browser-error-log-protocol';
import { useLocale } from '../../i18n/react';
import './breadcrumbs.css';

function networkSummary(category: string, data: Record<string, string | number | boolean | null> | undefined, locale: 'en' | 'ko') {
  if ((category !== 'http' && category !== 'network') ||
      typeof data?.method !== 'string' || !data.method.trim() ||
      typeof data.url !== 'string' || !data.url.trim()) return null;

  const status = typeof data.status === 'number' && Number.isInteger(data.status) && data.status >= 100 && data.status <= 599
    ? data.status : locale === 'ko' ? '상태 확인 불가' : 'Status unavailable';
  const duration = typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0
    ? ` · ${data.durationMs} ms` : '';
  return <p className="breadcrumb-network-summary">{data.method} {data.url} · {status}{duration}</p>;
}

export function BreadcrumbTrail({ breadcrumbs }: { breadcrumbs?: unknown }) {
  const locale = useLocale();
  if (!isBreadcrumbTrail(breadcrumbs) || breadcrumbs.length === 0) return null;

  return <section className="breadcrumb-trail" aria-label={locale === 'ko' ? '오류 전 작업 기록' : 'Activity before this error'}>
    <h4>{locale === 'ko' ? '오류 전 작업 기록' : 'Activity before this error'}</h4>
    <p className="breadcrumb-note">{locale === 'ko' ? '작업 기록 · 오래된 순' : 'Recorded steps, oldest first'}</p>
    <ol className="breadcrumb-list">
      {breadcrumbs.map((entry, index) => <li className="breadcrumb-entry" key={`${entry.occurredAt}-${index}`}>
        <div className="breadcrumb-meta"><time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { hour12: false })}</time><span className="breadcrumb-category">{entry.category}</span></div>
        <p className="breadcrumb-message">{entry.message}</p>
        {networkSummary(entry.category, entry.data, locale)}
        {entry.data && Object.keys(entry.data).length > 0 && <details className="breadcrumb-data"><summary>{locale === 'ko' ? '추가 정보' : 'Details'}</summary><dl>{Object.entries(entry.data).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value === null ? 'null' : String(value)}</dd></div>)}</dl></details>}
      </li>)}
    </ol>
  </section>;
}
