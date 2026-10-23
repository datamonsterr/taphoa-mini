const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      'dist/*',
      'dist-*/*',
      'coverage/*',
      'playwright-report/*',
      'e2e-web/test-results/*',
      'e2e-web/screenshots/*',
    ],
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { Buffer: 'readonly', process: 'readonly', console: 'readonly' },
    },
  },
]);
