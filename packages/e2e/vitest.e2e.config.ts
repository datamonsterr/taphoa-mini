import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Live suites share the backend's inference slot. Keep latency samples
      // independent of OCR, segmentation and enrollment in other test files.
      fileParallelism: false,
      globalSetup: ['./src/global-setup.ts'],
      env: {
        BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:8080',
      },
    },
  }),
);
