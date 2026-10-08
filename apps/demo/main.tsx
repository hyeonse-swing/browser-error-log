import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { init } from 'browser-error-log';
import { ErrorBoundary } from 'browser-error-log-react';
import './style.css';

const client = init({ endpoint: '/api/events', project: 'sdk-playground', environment: 'development', release: 'local-0.1.0', captureConsole: true, flushIntervalMs: 1000 });
function BrokenComponent({ broken }: { broken: boolean }) {
  if (broken) throw new Error('Demo React render error: ProductSummary');
  return <p className="boundary-ok"><span/>The React component is rendering normally.</p>;
}
function Demo() {
  const [status, setStatus] = useState('Trigger an error below, then inspect it in the viewer.');
  const [broken, setBroken] = useState(false);
  const [boundaryKey, setBoundaryKey] = useState(0);
  const [stats, setStats] = useState(client.getStats());
  useEffect(() => { const timer = window.setInterval(() => setStats(client.getStats()), 500); return () => clearInterval(timer); }, []);
  const actions = [
    { label: 'JavaScript error', detail: 'Global error event', run: () => { setTimeout(() => { throw new TypeError('Demo JavaScript error: cannot read product.name'); }, 0); } },
    { label: 'Promise error', detail: 'Unhandled Promise rejection', run: () => { void Promise.reject(new Error('Demo Promise error: product load failed')); } },
    { label: 'HTTP 503 · fetch', detail: 'Server error with a response', run: () => { void fetch('/demo-api/failure'); } },
    { label: 'HTTP 503 · XHR', detail: 'XHR capture path', run: () => { const xhr = new XMLHttpRequest(); xhr.open('GET', '/demo-api/failure'); xhr.send(); } },
    { label: 'Network connection failure', detail: 'Disconnect the local test request', run: () => { void fetch('/demo-api/network').catch(() => {}); } },
    { label: 'Record an error manually', detail: 'Pass an error explicitly from catch', run: () => { client.captureException(new Error('Demo manual error: response format mismatch'), { context: { action: 'demo-manual' } }); } },
    { label: 'console.error', detail: 'Optional capture enabled for this demo only', run: () => { console.error(new Error('Demo console error: cart state mismatch')); } },
    { label: 'Canceled request · excluded', detail: 'AbortController cancellation is not captured as an error', run: () => { const control = new AbortController(); void fetch('/demo-api/slow', { signal: control.signal }).catch(() => {}); control.abort(); } },
  ];
  return <main>
    <header><a href="/" className="brand">↖ Browser Error Log</a><span className="badge">LOCAL SDK LAB</span></header>
    <section className="intro"><p className="eyebrow">01 / CAPTURE & VERIFY</p><h1>Trigger errors,<br/><em>inspect the results.</em></h1><p>The SDK captures errors and sends them to the local collector.<br/>No screen recording or real service data is used.</p></section>
    <div className="notice">This local test uses in-memory storage. Restarting the server clears all events.</div>
    <div className="actions">{actions.map((action, i) => <button key={action.label} onClick={() => { action.run(); setStatus(`${action.label} scenario started.`); }}><span className="number">{String(i + 1).padStart(2, '0')}</span><span><strong>{action.label}</strong><small>{action.detail}</small></span><span aria-hidden="true">↗</span></button>)}</div>
    <section className="react-test"><div><h2>React Error Boundary</h2><p>Capture component errors and show a fallback screen.</p></div><button className="secondary" onClick={() => setBroken(true)} disabled={broken}>Trigger render error</button>
      <ErrorBoundary key={boundaryKey} client={client} fallback={<div className="boundary-error">The error was captured. This is the fallback screen.<button onClick={() => { setBroken(false); setBoundaryKey(v => v + 1); }}>Restore component</button></div>}><BrokenComponent broken={broken}/></ErrorBoundary>
    </section>
    <footer><div role="status">{status}<small>Sent {stats.sent} · Queued {stats.queued} · Dropped {stats.dropped}</small></div><div className="footer-actions"><button className="secondary" onClick={async () => { await client.flush(); setStats(client.getStats()); setStatus('Send attempted. Check the viewer for events.'); }}>Send now</button><a className="primary" href="/" target="_blank" rel="noreferrer">Open viewer ↗</a></div></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
