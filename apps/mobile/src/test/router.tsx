import {
  screen as nativeScreen,
  waitFor as waitForNative,
} from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import path from 'node:path';

// Route regressions use the Expo web camera double. Device output/capture behavior is
// exercised separately in CameraPreview.native and CameraScreen.native suites.
jest.mock('@/features/camera/CameraPreview', () =>
  jest.requireActual('@/features/camera/CameraPreview.web'),
);

/**
 * Renders the real `src/app` route tree (root layout, providers, fonts, stack) at `initialUrl`.
 * The root layout owns the query client, so every call starts with an empty cache.
 */
export async function renderApp(initialUrl = '/') {
  const result = await renderRouter(path.resolve(__dirname, '../app'), {
    initialUrl,
  });
  await waitForNative(() =>
    expect(nativeScreen.queryByTestId('auth-loading')).toBeNull(),
  );
  return result;
}

export {
  act,
  fireEvent,
  screen,
  testRouter,
  waitFor,
  within,
} from 'expo-router/testing-library';
