import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Live suites share the backend's inference slot. Keep latency samples
      // independent of OCR, segmentation and enrollment in other test files.
      fileParallelism: false,
      // The first recognition request after a deploy can include a model load.
      testTimeout: 60000,
      setupFiles: ['./src/cleanup-setup.ts'],
      globalSetup: ['./src/global-setup.ts'],
      env: {
        BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:8080',
      },
    },
  }),
);
