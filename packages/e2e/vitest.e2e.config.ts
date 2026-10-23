import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      env: {
        BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:8080',
      },
    },
  }),
);
