import { useEffect, useMemo, useState } from 'react';
import type { ErrorEventRecord } from '@ihyeon/browser-error-log-protocol';
import { useLocale } from '../../i18n/react';
import { OriginalLocations } from './SourceMapControls';
import { viewerConfig } from './data-source';
import { combineRegistries, fetchRegisteredMap } from './private-source-maps';
import { emptySourceMaps, generatedAssetUrls, registerSourceMap, type MapRegistry } from './source-maps';

type Props = { event: ErrorEventRecord; sourceMaps: MapRegistry };
const maxLookups = 32;

function RegisteredLocations({ event, sourceMaps, assets }: Props & { assets: string[] }) {
  const locale = useLocale();
  const [remote, setRemote] = useState(emptySourceMaps);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const { project, environment, release } = event;
  useEffect(() => {
    const controller = new AbortController();
    const deadline = window.setTimeout(() => {
      controller.abort();
      setStatus('error');
    }, 30_000);
    async function load() {
      let maps = emptySourceMaps();
      let incomplete = assets.length > maxLookups;
      for (const assetUrl of assets.slice(0, maxLookups)) {
        try {
          const map = await fetchRegisteredMap({ project, environment, release, assetUrl }, controller.signal);
          if (controller.signal.aborted) return;
          if (map) {
            maps = registerSourceMap(maps, map);
            setRemote(maps);
          }
        } catch {
          incomplete = true;
        }
        if (controller.signal.aborted) return;
      }
      window.clearTimeout(deadline);
      setRemote(maps);
      setStatus(incomplete ? 'error' : 'ready');
    }
    void load();
    return () => {
      window.clearTimeout(deadline);
      controller.abort();
    };
  }, [project, environment, release, assets, attempt]);
  const maps = useMemo(() => combineRegistries(sourceMaps, remote), [sourceMaps, remote]);
  return <>
    {status === 'loading' && <p role="status">{locale === 'ko' ? '등록 소스맵을 불러오는 중…' : 'Loading registered maps…'}</p>}
    {status === 'error' && <p role="status">{locale === 'ko' ? '일부 등록 소스맵을 불러오지 못했습니다.' : 'Some registered maps could not be loaded.'}{' '}
      <button type="button" onClick={() => { setStatus('loading'); setAttempt(n => n + 1); }}>
        {locale === 'ko' ? '다시 시도' : 'Retry'}
      </button></p>}
    <OriginalLocations event={event} sourceMaps={maps}/>
  </>;
}

export function EventSourceLocations({ event, sourceMaps, live }: Props & { live: boolean }) {
  const { project, environment, release, stack, componentStack } = event;
  const assets = useMemo(() => generatedAssetUrls({ stack, componentStack }), [stack, componentStack]);
  if (!live || import.meta.env.MODE === 'archive' || viewerConfig.mode !== 'live' ||
      viewerConfig.sourceMapRegistry !== true || !release || release === 'unknown' || !assets.length) {
    return <OriginalLocations event={event} sourceMaps={sourceMaps}/>;
  }
  return <RegisteredLocations key={JSON.stringify([project, environment, release, assets])}
    event={event} sourceMaps={sourceMaps} assets={assets}/>;
}
