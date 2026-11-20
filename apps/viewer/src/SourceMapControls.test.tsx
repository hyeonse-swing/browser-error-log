import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TraceMap } from '@jridgewell/trace-mapping';
import type { ErrorEventRecord } from '@ihyeon/browser-error-log-protocol';
import { setLocale } from '../../i18n/locale';
import { OriginalLocations, SourceMapPanel } from './SourceMapControls';
import { emptySourceMaps, registerSourceMap, removeSourceMap, sourceMapKey, type PreparedSourceMap } from './source-maps';

const manifest = {
  schemaVersion: 1 as const,
  project: 'web', environment: 'production', release: '2026.11.19',
  assetUrl: 'https://cdn.example/assets/app.js',
  bundleSha256: 'a'.repeat(64), mapSha256: 'b'.repeat(64),
};

const registration: PreparedSourceMap = {
  key: sourceMapKey(manifest), manifest,
  bundleSha256: manifest.bundleSha256, mapSha256: manifest.mapSha256, byteLength: 100, segmentCount: 1,
  trace: new TraceMap({ version: 3, sources: ['src/original.ts'], names: [], mappings: 'AAAA' }),
};

const event: ErrorEventRecord = {
  schemaVersion: 1, eventId: 'one', project: manifest.project, environment: manifest.environment,
  release: manifest.release, sdkVersion: '0.2.20', occurredAt: '2026-11-19T00:00:00.000Z',
  viewId: 'view', sequence: 1, elapsedMs: 1, type: 'javascript', message: 'Test',
  stack: 'Error: Test\n    at run (https://cdn.example/assets/app.js:1:1)', page: 'https://app.example/', runtime: 'browser',
};

function Example() {
  const [sourceMaps, setSourceMaps] = useState(emptySourceMaps);
  return <>
    <SourceMapPanel sourceMaps={sourceMaps} onRegisterMap={async () => {
      setSourceMaps(current => registerSourceMap(current, registration));
      return 'registered';
    }} onRemoveMap={key => setSourceMaps(current => removeSourceMap(current, key))}/>
    <OriginalLocations event={event} sourceMaps={sourceMaps}/>
  </>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale('en');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLocale('en');
});

it('updates an already visible location when a map is registered and removed', async () => {
  await act(async () => root.render(<Example/>));
  expect(container.querySelector('.source-map-locations')?.textContent).toContain('No map is registered');

  const [manifestInput, mapInput] = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(manifestInput, 'files', { configurable: true, value: [new File(['{}'], 'manifest.json')] });
  Object.defineProperty(mapInput, 'files', { configurable: true, value: [new File(['{}'], 'app.js.map')] });
  await act(async () => {
    container.querySelector<HTMLFormElement>('.source-map-panel form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(container.querySelector('.source-map-locations')?.textContent).toContain('src/original.ts:1:1');
  expect(container.querySelector('.source-map-entries')?.textContent).toContain(manifest.release);

  await act(async () => { container.querySelector<HTMLButtonElement>('.source-map-entries button')!.click(); });
  expect(container.querySelector('.source-map-locations')?.textContent).toContain('No map is registered');
});

it('shows an event without a JavaScript stack without inventing an original location', async () => {
  await act(async () => root.render(<OriginalLocations event={{ ...event, stack: undefined }} sourceMaps={emptySourceMaps()}/>));
  expect(container.querySelector('.source-map-locations')?.textContent).toContain('No JavaScript stack to map');
  expect(container.querySelector('.source-map-locations')?.textContent).not.toContain('src/original.ts');
});

it('shows a bounded local source excerpt only after opening it and escapes source markup', async () => {
  const withContent = { ...registration, sourceContents: new Map([[0, 'const x = <img src=x onerror=alert(1)>;\r\nnext']]) };
  const sourceMaps = registerSourceMap(emptySourceMaps(), withContent);
  await act(async () => root.render(<OriginalLocations event={{
    ...event, componentStack: `    at ProductSummary (${manifest.assetUrl}:1:1)\n    at App`,
  }} sourceMaps={sourceMaps}/>));
  expect(container.querySelectorAll('.source-map-preview')).toHaveLength(0);
  expect(container.querySelector('.source-map-locations')?.textContent).toContain('ProductSummary');
  expect(container.querySelector('.source-map-locations')?.textContent).toContain('at App');
  expect(container.querySelector('.source-map-locations')?.textContent).toContain('React did not provide a source position');
  const button = container.querySelector<HTMLButtonElement>('.source-map-locations button')!;
  await act(async () => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('.source-map-preview')?.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(container.querySelector('.source-map-preview img')).toBeNull();
  expect(container.querySelector('.source-map-preview mark')?.textContent).toBe('c');
  await act(async () => button.click());
  expect(container.querySelector('.source-map-preview')).toBeNull();
});

it('states when a mapped source has no embedded content', async () => {
  const sourceMaps = registerSourceMap(emptySourceMaps(), registration);
  await act(async () => root.render(<OriginalLocations event={event} sourceMaps={sourceMaps}/>));
  expect(container.querySelector('.source-map-locations')?.textContent).toContain('Original source content is unavailable');
  expect(container.querySelector('.source-map-locations button')).toBeNull();
});
