import { useRef, useState, type FormEvent } from 'react';
import type { ErrorEventRecord } from '@ihyeon/browser-error-log-protocol';
import { useLocale } from '../../i18n/react';
import { t } from './i18n';
import { resolveComponentStack, resolveStack, sourceExcerpt, type MapRegistry, type ResolvedFrame } from './source-maps';
import './source-map-controls.css';

export type RegisterOutcome = 'registered' | 'already-registered' | 'conflict';
export type SourceMapActions = {
  sourceMaps: MapRegistry;
  onRegisterMap: (manifest: File, map: File) => Promise<RegisterOutcome>;
  onRemoveMap: (key: string) => void;
};

const reasons = {
  'no-stack': 'No JavaScript stack to map.',
  'unrecognized-frame': 'Stack frame could not be parsed.',
  'unknown-release': 'The event has no usable release.',
  'no-registration': 'No map is registered for this release and file.',
  'registration-conflict': 'Conflicting maps are registered for this release and file.',
  'no-mapping': 'The map has no original location for this position.',
  'invalid-frame': 'Stack frame has an invalid position.',
  'no-location': 'React did not provide a source position for this component.',
} as const;

const inputErrors: Record<string, string> = {
  'manifest-too-large': 'Registration manifest is too large.',
  'invalid-manifest': 'Registration manifest is invalid.',
  'map-too-large': 'Source map file is too large.',
  'map-hash-mismatch': 'Source map file does not match its manifest hash.',
  'unsupported-map': 'This source map format is unsupported.',
  'invalid-map': 'Source map file is invalid.',
  'registry-full': 'Remove a registered map before adding another.',
  'crypto-unavailable': 'This browser cannot verify file hashes.',
};

function inputErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'SourceMapInputError') return inputErrors[error.message] ?? 'Registration manifest or source map is invalid.';
  if (error instanceof Error && error.message === 'Registration canceled after a map was removed. Choose both files again.') return error.message;
  return 'Could not register the map. Check the files and try again.';
}

export function SourceMapPanel({ sourceMaps, onRegisterMap, onRemoveMap, compact = false }: SourceMapActions & { compact?: boolean }) {
  const locale = useLocale();
  const manifestInput = useRef<HTMLInputElement>(null);
  const mapInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'status'; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const manifest = manifestInput.current?.files?.[0];
    const map = mapInput.current?.files?.[0];
    if (!manifest || !map || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      const result = await onRegisterMap(manifest, map);
      const text = result === 'conflict' ? 'Map conflict. Remove the entry and register the intended map.'
        : result === 'already-registered' ? 'This map is already registered.' : 'Source map registered for this session.';
      setFeedback({ kind: 'status', text });
      if (manifestInput.current) manifestInput.current.value = '';
      if (mapInput.current) mapInput.current.value = '';
    } catch (error) {
      setFeedback({ kind: 'error', text: inputErrorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return <details className={`source-map-panel ${compact ? 'source-map-panel-compact' : ''}`}>
    <summary>{t(locale, 'Local source maps')} <span>{sourceMaps.entries.size}</span></summary>
    <div className="source-map-panel-body">
      <p>{t(locale, 'Register a release manifest and its matching .map file. Maps stay in this browser tab until reload.')}</p>
      <form onSubmit={event => void submit(event)}>
        <label>{t(locale, 'Registration manifest')}<input ref={manifestInput} type="file" accept=".json,application/json" required disabled={pending}/></label>
        <label>{t(locale, 'Source map file')}<input ref={mapInput} type="file" accept=".map,.json,application/json" required disabled={pending}/></label>
        <button type="submit" disabled={pending}>{t(locale, pending ? 'Registering map…' : 'Register map')}</button>
      </form>
      {feedback && <p role={feedback.kind === 'error' ? 'alert' : 'status'} className={feedback.kind === 'error' ? 'source-map-error' : ''}>{t(locale, feedback.text)}</p>}
      {sourceMaps.entries.size > 0 && <ul className="source-map-entries">{[...sourceMaps.entries.values()].map(entry => <li key={entry.key}>
        <div><strong>{entry.manifest.project} / {entry.manifest.environment} / {entry.manifest.release}</strong><small>{entry.manifest.assetUrl}</small>{sourceMaps.conflicts.has(entry.key) && <em>{t(locale, 'Conflict — mapping disabled until removed.')}</em>}</div>
        <button type="button" onClick={() => { onRemoveMap(entry.key); setFeedback(null); }} aria-label={`${t(locale, 'Remove map')} ${entry.manifest.project} ${entry.manifest.release} · ${entry.manifest.environment} · ${entry.manifest.assetUrl}`}>{t(locale, 'Remove map')}</button>
      </li>)}</ul>}
    </div>
  </details>;
}

function FrameLocation({ frame, sourceMaps, component = false }: {
  frame: ResolvedFrame; sourceMaps: MapRegistry; component?: boolean;
}) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const reference = frame.sourceReference;
  const hasContent = reference && !sourceMaps.conflicts.has(reference.key) &&
    sourceMaps.entries.get(reference.key)?.sourceContents?.has(reference.index);
  const excerpt = open ? sourceExcerpt(frame, sourceMaps) : null;
  return <li>
    {component && frame.name && <strong className="source-map-component-name">{frame.name}</strong>}
    {frame.generated && <div><span>{t(locale, 'Generated')}</span> <code>{frame.generated.url}:{frame.generated.line}:{frame.generated.column}</code></div>}
    {frame.original && <div><span>{t(locale, 'Original')}</span> <code>{frame.original.source}:{frame.original.line}:{frame.original.column}</code></div>}
    {component && (!frame.generated || !frame.name) && <code className="source-map-raw-frame">{frame.raw}</code>}
    {frame.reason && <small>{t(locale, reasons[frame.reason])}</small>}
    {frame.original && (!hasContent ? <small>{t(locale, 'Original source content is unavailable in this map.')}</small>
      : <>
        <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {t(locale, open ? 'Hide source' : 'View source')}
        </button>
        {excerpt && (excerpt.status === 'available' ? <div className="source-map-preview" role="region" aria-label={t(locale, 'Original source excerpt')}>
          <div className="source-map-preview-lines">{excerpt.lines.map(line => <div key={line.number} className={line.marked ? 'source-map-preview-target' : undefined}>
            <span aria-hidden="true" className="source-map-preview-number">{line.number}</span>
            <code>{line.before}{line.marked && <mark aria-label={`${t(locale, 'Original column')} ${frame.original?.column}`}>{line.marked}</mark>}{line.after}</code>
          </div>)}</div>
        </div> : <small>{t(locale, excerpt.status === 'missing-line' ? 'Original source line is unavailable.'
          : excerpt.status === 'missing-column' ? 'Original source column is outside the line.'
            : 'Original source content is unavailable in this map.')}</small>)}
      </>)}
  </li>;
}

export function OriginalLocations({ event, sourceMaps }: { event: ErrorEventRecord; sourceMaps: MapRegistry }) {
  const locale = useLocale();
  const frames = resolveStack(event, sourceMaps);
  const componentFrames = resolveComponentStack(event, sourceMaps);
  return <section className="source-map-locations" aria-label={t(locale, 'Original locations')}>
    <h4>{t(locale, 'Original locations')}</h4>
    <h5>{t(locale, 'JavaScript frames')}</h5>
    {frames.length === 0 ? <p>{t(locale, 'No JavaScript stack to map.')}</p> : <ol>{frames.map((frame, index) =>
      <FrameLocation key={`js-${index}-${frame.raw}`} frame={frame} sourceMaps={sourceMaps}/>)}</ol>}
    {componentFrames.length > 0 && <>
      <h5>{t(locale, 'React component frames')}</h5>
      <ol>{componentFrames.map((frame, index) =>
        <FrameLocation key={`component-${index}-${frame.raw}`} frame={frame} sourceMaps={sourceMaps} component/>)}</ol>
    </>}
  </section>;
}
