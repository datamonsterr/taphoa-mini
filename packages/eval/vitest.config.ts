import { configDefaults, defineConfig } from 'vitest/config';

// Integration tests need a seeded database: `pnpm test:integration` runs them.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
  },
});
