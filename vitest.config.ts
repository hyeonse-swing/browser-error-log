import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: {
    '@browser-error-log/protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
    '@browser-error-log/browser': fileURLToPath(new URL('./packages/browser/src/index.ts', import.meta.url)),
    '@browser-error-log/react': fileURLToPath(new URL('./packages/react/src/index.tsx', import.meta.url)),
  } },
  test: { environment: 'jsdom', include: ['packages/**/*.test.{ts,tsx}', 'apps/**/*.test.{ts,tsx}', 'examples/micro-server/src/**/*.test.ts', 'tests/**/*.test.ts'], restoreMocks: true },
});
