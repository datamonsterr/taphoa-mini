const { defineConfig } = require('eslint/config');
const { fixupPluginRules } = require('@eslint/compat');
const expoConfig = require('eslint-config-expo/flat');

// eslint-plugin-react still uses context APIs removed in ESLint 10.
const compatibleExpoConfig = expoConfig.map((config) =>
  config.plugins?.react
    ? {
        ...config,
        plugins: {
          ...config.plugins,
          react: fixupPluginRules(config.plugins.react),
        },
      }
    : config,
);

module.exports = defineConfig([
  compatibleExpoConfig,
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
