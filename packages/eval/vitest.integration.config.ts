import { defineConfig } from 'vitest/config';

// Tests that read EVAL_DATABASE_URL (a database seeded with
// `taphoa-seed --profile eval`). Without it they skip.
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
