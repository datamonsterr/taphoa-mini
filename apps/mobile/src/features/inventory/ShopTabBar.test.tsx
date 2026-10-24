import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';

import { ShopTabBar } from './ShopTabBar';

jest.mock('expo-router', () => ({
  router: { dismissTo: jest.fn() },
}));

const routes = [
  { key: 'inventory-1', name: 'inventory' },
  { key: 'dashboard-1', name: 'dashboard' },
  { key: 'account-1', name: 'account' },
];

const renderBar = async (index: number, bottom = 0) => {
  const navigateToTab = jest.fn();
  const props = {
    state: { index, routes },
    navigateToTab,
    insets: { top: 0, left: 0, right: 0, bottom },
  } as unknown as Parameters<typeof ShopTabBar>[0];
  await renderWithProviders(<ShopTabBar {...props} />);
  return { navigateToTab };
};

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

beforeEach(() => jest.clearAllMocks());

test('marks the focused route as the current tab', async () => {
  await renderBar(1);
  expect(
    screen.getByRole('tab', { name: 'Báo cáo' }).props.accessibilityState,
  ).toMatchObject({ selected: true });
  expect(
    screen.getByRole('tab', { name: 'Kho' }).props.accessibilityState,
  ).toMatchObject({ selected: false });
});

test.each([
  ['Kho', 'inventory-1'],
  ['Báo cáo', 'dashboard-1'],
  ['Tài khoản', 'account-1'],
])('pressing %s navigates to its tab', async (name, key) => {
  const { navigateToTab } = await renderBar(0);
  await fireEvent.press(screen.getByRole('tab', { name }));
  expect(navigateToTab).toHaveBeenCalledWith(key);
});

test('a tab missing from the routes is ignored', async () => {
  const navigateToTab = jest.fn();
  const props = {
    state: { index: 0, routes: [routes[0]] },
    navigateToTab,
    insets: { top: 0, left: 0, right: 0, bottom: 0 },
  } as unknown as Parameters<typeof ShopTabBar>[0];
  await renderWithProviders(<ShopTabBar {...props} />);
  await fireEvent.press(screen.getByRole('tab', { name: 'Báo cáo' }));
  expect(navigateToTab).not.toHaveBeenCalled();
});

test('camera FAB dismisses back to the camera', async () => {
  await renderBar(0);
  await fireEvent.press(screen.getByRole('button', { name: 'Mở camera' }));
  expect(router.dismissTo).toHaveBeenCalledWith('/');
});

test('floats 16px above the bottom plus the safe area', async () => {
  await renderBar(0, 20);
  expect(flat(screen.getByTestId('shop-tab-bar'))).toMatchObject({
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 36,
  });
});

test('labels follow the language setting', async () => {
  useSettingsStore.setState({ language: 'en' });
  await renderBar(0);
  for (const name of ['Stock', 'Reports', 'Account']) {
    expect(screen.getByRole('tab', { name })).toBeOnTheScreen();
  }
  expect(screen.getByRole('button', { name: 'Open camera' })).toBeOnTheScreen();
});
