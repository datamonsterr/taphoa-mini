/* eslint-disable @typescript-eslint/no-require-imports -- required lazily so a test file's own jest.mock calls still apply to these modules */

import { configure } from '@testing-library/react-native';

import { freezeDate } from './clock';

// Explicit, generous async timeouts: the mock API has no latency in tests, but coverage
// instrumentation and the real route tree make a render slow on a busy CI worker.
configure({ asyncUtilTimeout: 5000 });

// Every test starts from the seed data and empty stores, and leaves real timers behind, so no
// test depends on what an earlier one in the same worker did.
beforeEach(() => {
  // TEST_NOW (ISO instant) pins `Date` for the whole suite; see the `test:tz` script.
  if (process.env.TEST_NOW) freezeDate(process.env.TEST_NOW);
  const { useCaptureModeStore } = require('@/features/camera/modeStore');
  const { resetApiClient } = require('@/lib/api/client');
  const { resetMockDb } = require('@/lib/mock/db');
  const { initialChrome, useChromeStore } = require('@/stores/chrome');
  const { useCartStore } = require('@/stores/cart');
  const { initialSettings, useSettingsStore } = require('@/stores/settings');
  resetMockDb();
  resetApiClient();
  useChromeStore.setState(initialChrome);
  useCartStore.setState({ lines: [] });
  useCaptureModeStore.setState({ mode: 'one' });
  useSettingsStore.setState(initialSettings);
});

afterEach(() => {
  jest.useRealTimers();
});
