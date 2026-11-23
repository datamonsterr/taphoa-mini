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
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/components/icons.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['lucide-react-native', 'lucide-react-native/*'],
              message:
                'Import icons from @/components/icons to keep the bundle small.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/theme/**', 'src/**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='fontSize'] > Literal[raw=/^[0-9.]/]",
          message:
            'No numeric fontSize literals. Use typography.* or fontSize[n] from @/theme.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { Buffer: 'readonly', process: 'readonly', console: 'readonly' },
    },
  },
]);
