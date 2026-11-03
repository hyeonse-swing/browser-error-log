import { isBreadcrumbTrail } from '@ihyeon/browser-error-log-protocol';
import { useLocale } from '../../i18n/react';
import './breadcrumbs.css';

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
        {entry.data && Object.keys(entry.data).length > 0 && <details className="breadcrumb-data"><summary>{locale === 'ko' ? '추가 정보' : 'Details'}</summary><dl>{Object.entries(entry.data).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value === null ? 'null' : String(value)}</dd></div>)}</dl></details>}
      </li>)}
    </ol>
  </section>;
}
