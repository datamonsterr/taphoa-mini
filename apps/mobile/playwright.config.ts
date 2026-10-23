import { defineConfig, devices } from '@playwright/test';

const PORT = 8099;
const isCi = !!process.env.CI;

export default defineConfig({
  testDir: './e2e-web',
  outputDir: './e2e-web/test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  workers: isCi ? 2 : undefined,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    permissions: ['camera'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /perf\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      },
    },
    {
      // Timing needs an idle machine: this project starts only after every functional spec ended.
      name: 'perf',
      testMatch: /perf\.spec\.ts/,
      dependencies: ['chromium'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      },
    },
  ],
  // Production web export served statically; expo serve maps clean URLs to .html.
  webServer: {
    command: `pnpm exec expo export --platform web --output-dir dist-web && pnpm exec expo serve dist-web --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !isCi,
    timeout: 300_000,
  },
});
