import { fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Dimensions } from 'react-native';

import { useAssistantEnabled } from '@/features/assistant/flags';
import { useChromeStore } from '@/stores/chrome';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';

import { MIN_BESIDE_WIDTH } from './chatButtonPlacement';
import { ShopTabBar } from './ShopTabBar';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { dismissTo: jest.fn() },
  useRouter: () => ({ push: (...args: unknown[]) => mockPush(...args) }),
}));

jest.mock('@/features/assistant/flags', () => ({
  useAssistantEnabled: jest.fn(() => true),
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

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useAssistantEnabled).mockReturnValue(true);
});

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

const setWidth = (width: number) =>
  jest.spyOn(Dimensions, 'get').mockReturnValue({
    width,
    height: 800,
    scale: 1,
    fontScale: 1,
  });

describe('chat button', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([
    [0, 'inventory'],
    [1, 'dashboard'],
    [2, 'account'],
  ])('shows on tab %i and opens the assistant for it', async (index, name) => {
    await renderBar(index);
    await fireEvent.press(screen.getByRole('button', { name: 'Mở trợ lý' }));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/assistant',
      params: { entry: 'button', screen: name },
    });
  });

  test('sits in the bar row to the right of the tab pill', async () => {
    setWidth(390);
    await renderBar(0);
    expect(flat(screen.getByTestId('shop-tab-row'))).toMatchObject({
      flexDirection: 'row',
    });
    const row = screen.getByTestId('shop-tab-row');
    expect(row.children[row.children.length - 1]).toBe(
      screen.getByTestId('chat-button-slot'),
    );
    expect(
      within(screen.getByTestId('chat-button-slot')).getByTestId('chat-button'),
    ).toBeOnTheScreen();
  });

  test('moves above the right end of the bar when the window is too narrow', async () => {
    setWidth(MIN_BESIDE_WIDTH - 1);
    await renderBar(0);
    expect(flat(screen.getByTestId('shop-tab-row'))).toMatchObject({
      flexDirection: 'column-reverse',
    });
    expect(flat(screen.getByTestId('chat-button-slot'))).toMatchObject({
      alignSelf: 'flex-end',
      marginBottom: 12,
    });
    expect(screen.getByTestId('chat-button')).toBeOnTheScreen();
  });

  test('stays beside the pill at the narrowest fitting width', async () => {
    setWidth(MIN_BESIDE_WIDTH);
    await renderBar(0);
    expect(flat(screen.getByTestId('shop-tab-row'))).toMatchObject({
      flexDirection: 'row',
    });
  });

  test('is hidden with the tab bar', async () => {
    useChromeStore.setState({ tabBarHidden: true });
    await renderBar(0);
    expect(screen.queryByTestId('chat-button')).toBeNull();
    expect(screen.queryByTestId('shop-tab-bar')).toBeNull();
  });

  test('label follows the language', async () => {
    useSettingsStore.setState({ language: 'en' });
    await renderBar(0);
    expect(
      screen.getByRole('button', { name: 'Open assistant' }),
    ).toBeOnTheScreen();
  });
});

describe('assistant flag off', () => {
  beforeEach(() => jest.mocked(useAssistantEnabled).mockReturnValue(false));
  afterEach(() => jest.restoreAllMocks());

  test.each([390, MIN_BESIDE_WIDTH - 1])(
    'renders the bar as before, with no chat slot at width %i',
    async (width) => {
      setWidth(width);
      await renderBar(0);
      expect(screen.queryByTestId('chat-button-slot')).toBeNull();
      expect(screen.queryByTestId('shop-tab-row')).toBeNull();
      expect(screen.queryByTestId('chat-button')).toBeNull();
      // The pill is the direct child of the bar again, so nothing is reserved beside or above it.
      const bar = screen.getByTestId('shop-tab-bar');
      expect(bar.children).toHaveLength(1);
      expect(within(bar).getByRole('tab', { name: 'Kho' })).toBeOnTheScreen();
      expect(
        within(bar).getByRole('button', { name: 'Mở camera' }),
      ).toBeOnTheScreen();
    },
  );
});
