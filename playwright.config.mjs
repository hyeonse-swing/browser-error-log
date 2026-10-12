import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'output/playwright/browser',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure', screenshot: 'only-on-failure' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], trace: 'retain-on-failure', screenshot: 'only-on-failure' } },
  ],
});
