import { defineConfig, devices } from '@playwright/test';

import { existsSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.E2E_WEB_PORT ?? 8099);
const isCi = !!process.env.CI;
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
// The .y4m/.mjpeg clip the fake camera plays (see e2e-web/fixtures/make-video.sh). The product
// photo is the default when the script has been run; without a clip Chromium's own test pattern
// plays and the recognition specs fail on purpose.
const DEFAULT_VIDEO = path.join(__dirname, 'e2e-web/fixtures/product.mjpeg');
const FAKE_VIDEO =
  process.env.PLAYWRIGHT_FAKE_VIDEO ??
  (existsSync(DEFAULT_VIDEO) ? DEFAULT_VIDEO : undefined);

export default defineConfig({
  testDir: './e2e-web',
  outputDir: './e2e-web/test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  workers: isCi ? 2 : undefined,
  globalSetup: './e2e-web/global-setup.ts',
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
        ...(FAKE_VIDEO
          ? [`--use-file-for-fake-video-capture=${FAKE_VIDEO}`]
          : []),
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
    // The export embeds EXPO_PUBLIC_* values: the app talks to the real backend at API_URL.
    env: { EXPO_PUBLIC_API_URL: API_URL },
  },
});
