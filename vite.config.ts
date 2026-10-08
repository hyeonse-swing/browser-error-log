import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { localCollector } from './apps/local-collector/plugin.ts';

function collectorTarget(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('ERROR_LOG_COLLECTOR_URL must be a loopback HTTP origin'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || value !== url.origin || url.username || url.password) {
    throw new Error('ERROR_LOG_COLLECTOR_URL must be a loopback HTTP origin');
  }
  return url.origin;
}

const externalCollector = collectorTarget(process.env.ERROR_LOG_COLLECTOR_URL);

export default defineConfig({
  root: 'apps/viewer',
  resolve: { alias: {
    'browser-error-log-protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
    'browser-error-log': fileURLToPath(new URL('./packages/browser/src/index.ts', import.meta.url)),
    'browser-error-log-react': fileURLToPath(new URL('./packages/react/src/index.tsx', import.meta.url)),
  } },
  plugins: [localCollector(Boolean(externalCollector))],
  server: { port: 4317, strictPort: true, ...(externalCollector ? { proxy: { '/api': { target: externalCollector, changeOrigin: true } } } : {}) },
  preview: { port: 4317, strictPort: true },
  build: {
    outDir: '../../dist/viewer', emptyOutDir: true,
    rolldownOptions: { input: { main: fileURLToPath(new URL('./apps/viewer/index.html', import.meta.url)), demo: fileURLToPath(new URL('./apps/viewer/demo.html', import.meta.url)) } },
  },
});
