import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { init } from 'browser-error-log';
import { ErrorBoundary } from 'browser-error-log-react';
import { LanguageSwitcher, useLocale } from '../i18n/react';
import './style.css';

const client = init({ endpoint: '/api/events', project: 'sdk-playground', environment: 'development', release: 'local-0.1.0', captureConsole: true, flushIntervalMs: 1000 });
function BrokenComponent({ broken }: { broken: boolean }) {
  const locale = useLocale();
  if (broken) throw new Error('Demo React render error: ProductSummary');
  return <p className="boundary-ok"><span/>{copy[locale].healthy}</p>;
}
const copy = {
  en: {
    title: 'SDK Lab · Browser Error Log', badge: 'LOCAL SDK LAB', eyebrow: '01 / CAPTURE & VERIFY',
    heading: 'Trigger errors,', emphasis: 'inspect the results.',
    description: 'The SDK captures errors and sends them to the local collector.',
    privacy: 'No screen recording or real service data is used.',
    notice: 'This local test uses in-memory storage. Restarting the server clears all events.',
    ready: 'Trigger an error below, then inspect it in the viewer.', started: 'scenario started.',
    attempted: 'Send attempted. Check the viewer for events.',
    boundary: 'React Error Boundary', boundaryDescription: 'Capture component errors and show a fallback screen.',
    trigger: 'Trigger render error', healthy: 'The React component is rendering normally.',
    fallback: 'The error was captured. This is the fallback screen.', restore: 'Restore component',
    sent: 'Sent', queued: 'Queued', dropped: 'Dropped', send: 'Send now', viewer: 'Open viewer ↗',
    actions: [
      ['JavaScript error', 'Global error event'], ['Promise error', 'Unhandled Promise rejection'],
      ['HTTP 503 · fetch', 'Server error with a response'], ['HTTP 503 · XHR', 'XHR capture path'],
      ['Network connection failure', 'Disconnect the local test request'],
      ['Record an error manually', 'Pass an error explicitly from catch'],
      ['console.error', 'Optional capture enabled for this demo only'],
      ['Canceled request · excluded', 'AbortController cancellation is not captured as an error'],
    ],
  },
  ko: {
    title: 'SDK 실습 · Browser Error Log', badge: '로컬 SDK 실습', eyebrow: '01 / 수집 및 확인',
    heading: '오류를 발생시키고,', emphasis: '결과를 확인하세요.',
    description: 'SDK가 오류를 수집해 로컬 수집 서버로 전송합니다.',
    privacy: '화면 녹화나 실제 서비스 데이터는 사용하지 않습니다.',
    notice: '이 로컬 실습은 메모리에 저장합니다. 서버를 다시 시작하면 모든 이벤트가 사라집니다.',
    ready: '아래에서 오류를 발생시킨 뒤 뷰어에서 확인하세요.', started: '시나리오를 시작했습니다.',
    attempted: '전송을 시도했습니다. 뷰어에서 이벤트를 확인하세요.',
    boundary: 'React 오류 경계', boundaryDescription: '컴포넌트 오류를 수집하고 대체 화면을 표시합니다.',
    trigger: '렌더링 오류 발생', healthy: 'React 컴포넌트가 정상적으로 렌더링되고 있습니다.',
    fallback: '오류를 수집했습니다. 현재 대체 화면을 표시하고 있습니다.', restore: '컴포넌트 복구',
    sent: '전송', queued: '대기', dropped: '버림', send: '지금 전송', viewer: '뷰어 열기 ↗',
    actions: [
      ['JavaScript 오류', '전역 오류 이벤트'], ['Promise 오류', '처리되지 않은 Promise 거부'],
      ['HTTP 503 · fetch', '응답이 있는 서버 오류'], ['HTTP 503 · XHR', 'XHR 요청 오류 수집'],
      ['네트워크 연결 실패', '로컬 테스트 요청의 연결 끊기'],
      ['오류 직접 기록', 'catch에서 오류를 명시적으로 전달'],
      ['console.error', '이 실습에서만 선택적으로 수집'],
      ['요청 취소 · 수집 제외', 'AbortController로 취소한 요청은 오류로 수집하지 않음'],
    ],
  },
};
function Demo() {
  const locale = useLocale();
  const text = copy[locale];
  const [status, setStatus] = useState<'ready' | 'attempted' | number>('ready');
  const [broken, setBroken] = useState(false);
  const [boundaryKey, setBoundaryKey] = useState(0);
  const [stats, setStats] = useState(client.getStats());
  useEffect(() => { document.title = text.title; document.documentElement.lang = locale; }, [locale, text.title]);
  useEffect(() => { const timer = window.setInterval(() => setStats(client.getStats()), 500); return () => clearInterval(timer); }, []);
  const actions = [
    () => { setTimeout(() => { throw new TypeError('Demo JavaScript error: cannot read product.name'); }, 0); },
    () => { void Promise.reject(new Error('Demo Promise error: product load failed')); },
    () => { void fetch('/demo-api/failure'); },
    () => { const xhr = new XMLHttpRequest(); xhr.open('GET', '/demo-api/failure'); xhr.send(); },
    () => { void fetch('/demo-api/network').catch(() => {}); },
    () => { client.captureException(new Error('Demo manual error: response format mismatch'), { context: { action: 'demo-manual' } }); },
    () => { console.error(new Error('Demo console error: cart state mismatch')); },
    () => { const control = new AbortController(); void fetch('/demo-api/slow', { signal: control.signal }).catch(() => {}); control.abort(); },
  ];
  return <main>
    <header><a href="/" className="brand">↖ Browser Error Log</a><div className="demo-toolbar"><span className="badge">{text.badge}</span><LanguageSwitcher/></div></header>
    <section className="intro"><p className="eyebrow">{text.eyebrow}</p><h1>{text.heading}<br/><em>{text.emphasis}</em></h1><p>{text.description}<br/>{text.privacy}</p></section>
    <div className="notice">{text.notice}</div>
    <div className="actions">{actions.map((action, i) => <button key={i} onClick={() => { action(); setStatus(i); }}><span className="number">{String(i + 1).padStart(2, '0')}</span><span><strong>{text.actions[i][0]}</strong><small>{text.actions[i][1]}</small></span><span aria-hidden="true">↗</span></button>)}</div>
    <section className="react-test"><div><h2>{text.boundary}</h2><p>{text.boundaryDescription}</p></div><button className="secondary" onClick={() => setBroken(true)} disabled={broken}>{text.trigger}</button>
      <ErrorBoundary key={boundaryKey} client={client} fallback={<div className="boundary-error">{text.fallback}<button onClick={() => { setBroken(false); setBoundaryKey(v => v + 1); }}>{text.restore}</button></div>}><BrokenComponent broken={broken}/></ErrorBoundary>
    </section>
    <footer><div role="status">{typeof status === 'number' ? `${text.actions[status][0]} ${text.started}` : text[status]}<small>{text.sent} {stats.sent.toLocaleString(locale)} · {text.queued} {stats.queued.toLocaleString(locale)} · {text.dropped} {stats.dropped.toLocaleString(locale)}</small></div><div className="footer-actions"><button className="secondary" onClick={async () => { await client.flush(); setStats(client.getStats()); setStatus('attempted'); }}>{text.send}</button><a className="primary" href="/" target="_blank" rel="noreferrer">{text.viewer}</a></div></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
