import { createElement as mockCreate } from 'react';
import { Text as MockText } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { router, useIsFocused } from 'expo-router';

import { initialSettings, useSettingsStore } from '@/stores/settings';

import { Home, resetStartRoute } from './Home';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useIsFocused: jest.fn(() => true),
}));
jest.mock('@/features/camera/CameraScreen', () => ({
  CameraScreen: () => mockCreate(MockText, null, 'camera'),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (useIsFocused as jest.Mock).mockReturnValue(true);
  resetStartRoute();
  useSettingsStore.setState(initialSettings);
});

test('opens on the camera by default', async () => {
  await render(<Home />);
  expect(await screen.findByText('camera')).toBeOnTheScreen();
  expect(router.push).not.toHaveBeenCalled();
});

test('elder mode opens on the grid and holds the camera back until the seller returns', async () => {
  useSettingsStore.setState({ elderMode: true });
  const view = await render(<Home />);
  expect(router.push).toHaveBeenCalledWith('/inventory');
  expect(screen.queryByText('camera')).toBeNull();

  (useIsFocused as jest.Mock).mockReturnValue(false);
  await act(async () => view.rerender(<Home />));
  expect(screen.queryByText('camera')).toBeNull();

  (useIsFocused as jest.Mock).mockReturnValue(true);
  await act(async () => view.rerender(<Home />));
  expect(screen.getByText('camera')).toBeOnTheScreen();
});

test('the start screen is chosen once per launch', async () => {
  await render(<Home />).then((v) => v.unmount());
  useSettingsStore.setState({ elderMode: true });
  await render(<Home />);
  expect(router.push).not.toHaveBeenCalled();
  expect(await screen.findByText('camera')).toBeOnTheScreen();
});
