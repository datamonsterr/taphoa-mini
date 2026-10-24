import { renderApp, screen, testRouter } from '@/test/router';

import appConfig from '../../app.json';

// expo-status-bar keeps a stack of mounted bars (the last one wins), so render each as a marker.
jest.mock('expo-status-bar', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories must require lazily
  const { View } = require('react-native');
  return {
    StatusBar: ({ style }: { style: string }) => (
      <View testID={`status-bar-${style}`} />
    ),
  };
});

test('app config is light-only with the camera-dark splash and icon background', () => {
  const { expo } = appConfig;
  expect(expo.userInterfaceStyle).toBe('light');
  expect(expo.android.adaptiveIcon.backgroundColor).toBe('#0c0c0e');
  const splash = expo.plugins.find(
    (p) => Array.isArray(p) && p[0] === 'expo-splash-screen',
  ) as [string, { backgroundColor: string }];
  expect(splash[1].backgroundColor).toBe('#0c0c0e');
});

test('status bar is light on the dark camera and dark on light screens', async () => {
  await renderApp('/');
  expect(screen).toHavePathname('/');
  expect(screen.getByTestId('status-bar-light')).toBeOnTheScreen();

  await testRouter.push('/dashboard');
  expect(screen.queryByTestId('status-bar-light')).toBeNull();
  expect(screen.getByTestId('status-bar-dark')).toBeOnTheScreen();

  await testRouter.navigate('/');
  expect(screen.getByTestId('status-bar-light')).toBeOnTheScreen();
});

test.each(['/dashboard', '/account', '/inventory'] as const)(
  'deep link %s opens its tab',
  async (url) => {
    await renderApp(url);
    expect(screen).toHavePathname(url);
    expect(screen.getByTestId('shop-tab-bar')).toBeOnTheScreen();
  },
);
