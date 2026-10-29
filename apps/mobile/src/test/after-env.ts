/* eslint-disable @typescript-eslint/no-require-imports -- required lazily so a test file's own jest.mock calls still apply to these modules */

import { configure } from '@testing-library/react-native';

import { freezeDate } from './clock';

// Explicit, generous async timeouts: the test double has no latency, but coverage
// instrumentation and the real route tree make a render slow on a busy CI worker.
configure({ asyncUtilTimeout: 5000 });

// Every test starts from the seed data and empty stores, and leaves real timers behind, so no
// test depends on what an earlier one in the same worker did.
beforeEach(() => {
  // TEST_NOW (ISO instant) pins `Date` for the whole suite; see the `test:tz` script.
  if (process.env.TEST_NOW) freezeDate(process.env.TEST_NOW);
  const { useCaptureModeStore } = require('@/features/camera/modeStore');
  const { setApiTransport } = require('@/lib/api/client');
  const { createMockFetch } = require('@/test/mock/fetch');
  const { resetMockDb } = require('@/test/mock/db');
  const { initialChrome, useChromeStore } = require('@/stores/chrome');
  const { useCartStore } = require('@/stores/cart');
  const { useLowStockAlerts } = require('@/stores/lowStockAlerts');
  const { initialSettings, useSettingsStore } = require('@/stores/settings');
  const {
    initialVoiceSettings,
    useVoiceSettings,
  } = require('@/features/voice/voiceSettings');
  resetMockDb();
  // The offline cache and the sale outbox persist on purpose: a test never inherits the last one's.
  require('@react-native-async-storage/async-storage').removeItem(
    require('@/lib/offline/persist').CACHE_STORAGE_KEY,
  );
  require('@/lib/outbox').resetOutbox();
  require('./clerk').resetClerkMock();
  require('@/features/auth/emailFlow').useEmailFlow.getState().reset();
  require('@/features/auth/addPerson').useAddPerson.getState().end();
  require('@/features/onboarding/inviteIntent')
    .useInviteIntent.getState()
    .setToken('');
  require('@/stores/currentStore').useCurrentStore.setState({
    storeIds: {},
    hydrated: true,
  });
  require('@/stores/deviceLock').useDeviceLock.setState({
    locked: false,
    hydrated: true,
  });
  require('@/lib/api/clerkBridge').registerAuthBridge({
    getToken: require('./clerk').clerkMock.getToken,
    getStoreId: () =>
      require('@/stores/currentStore').useCurrentStore.getState().storeIds
        .user_test ?? require('./session').testSession().store.id,
    membershipRequired: jest.fn(),
  });
  // The app only ever talks to the real backend; tests put the in-memory double underneath it.
  setApiTransport(createMockFetch());
  useChromeStore.setState(initialChrome);
  useCartStore.setState({ lines: [] });
  useLowStockAlerts.getState().reset();
  useCaptureModeStore.setState({ mode: 'one' });
  const {
    initialQuickEnroll,
    useQuickEnrollStore,
  } = require('@/features/camera/quickEnroll');
  useQuickEnrollStore.setState(initialQuickEnroll);
  require('@/features/receipts/ReceiptToast').useReceiptNotice.setState({
    count: null,
  });
  useSettingsStore.setState(initialSettings);
  useVoiceSettings.setState(initialVoiceSettings);
});

afterEach(() => {
  jest.useRealTimers();
});
