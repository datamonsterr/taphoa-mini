import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { onlineManager } from '@tanstack/react-query';
import { router } from 'expo-router';

import * as stockApi from '@/lib/api/stock';
import { useSettingsStore } from '@/stores/settings';
import { PRODUCT_IDS } from '@/test/mock';
import { holdNext } from '@/test/hold';
import { renderOffline, restoreOnline } from '@/test/offline';
import { renderWithProviders } from '@/test/render';

import { StockScreen } from './StockScreen';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
}));
afterEach(() => {
  restoreOnline();
  jest.restoreAllMocks();
});

test('renders API order with quantity, badge and thumbnail; a row opens product detail', async () => {
  await renderWithProviders(<StockScreen />);
  const rows = await screen.findAllByRole('button', {
    name: /^(Pepsi|Mì Hảo Hảo|Coca-Cola)/,
  });
  expect(rows.map((row) => row.props.accessibilityLabel)).toEqual([
    'Pepsi lon 330ml',
    'Mì Hảo Hảo tôm chua cay',
    'Coca-Cola lon 330ml',
  ]);
  expect(screen.getByLabelText('Tồn kho 0, Hết hàng')).toBeOnTheScreen();
  expect(screen.getByLabelText('Tồn kho 3, Sắp hết')).toBeOnTheScreen();
  expect(screen.getByLabelText('Tồn kho 20, Còn hàng')).toBeOnTheScreen();
  expect(screen.getAllByTestId('stock-photo')).toHaveLength(3);
  await fireEvent.press(rows[0]);
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/product/[id]',
    params: { id: PRODUCT_IDS.pepsi },
  });
});

test('filter chips request low, out and all statuses', async () => {
  const list = jest.spyOn(stockApi, 'listStock');
  await renderWithProviders(<StockScreen />);
  await screen.findByRole('button', { name: 'Coca-Cola lon 330ml' });
  await fireEvent.press(screen.getByRole('button', { name: 'Sắp hết' }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith({ status: 'low', cursor: null }),
  );
  expect(
    await screen.findByRole('button', { name: 'Mì Hảo Hảo tôm chua cay' }),
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Coca-Cola lon 330ml' }),
  ).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Hết hàng' }));
  expect(
    await screen.findByRole('button', { name: 'Pepsi lon 330ml' }),
  ).toBeOnTheScreen();
  expect(list).toHaveBeenLastCalledWith({ status: 'out', cursor: null });
  await fireEvent.press(screen.getByRole('button', { name: 'Tất cả' }));
  expect(
    await screen.findByRole('button', { name: 'Coca-Cola lon 330ml' }),
  ).toBeOnTheScreen();
});

test('empty state waits for the first load', async () => {
  jest
    .spyOn(stockApi, 'listStock')
    .mockResolvedValue({ items: [], next_cursor: null });
  const release = holdNext(stockApi, 'listStock');
  await renderWithProviders(<StockScreen />);
  expect(screen.getByLabelText('Đang tải')).toBeOnTheScreen();
  expect(screen.queryByText('Chưa có sản phẩm theo dõi tồn kho')).toBeNull();
  await act(async () => release());
  expect(
    await screen.findByText('Chưa có sản phẩm theo dõi tồn kho'),
  ).toBeOnTheScreen();
});

test('load failure can be retried', async () => {
  jest.spyOn(stockApi, 'listStock').mockRejectedValueOnce(new Error('offline'));
  await renderWithProviders(<StockScreen />);
  expect(await screen.findByText('Không tải được tồn kho')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  expect(
    await screen.findByRole('button', { name: 'Pepsi lon 330ml' }),
  ).toBeOnTheScreen();
});

test('pull to refresh and infinite scroll request fresh data and next cursor', async () => {
  const page = await stockApi.listStock();
  const list = jest
    .spyOn(stockApi, 'listStock')
    .mockImplementation(async ({ cursor } = {}) => ({
      items: cursor ? page.items.slice(1) : page.items.slice(0, 1),
      next_cursor: cursor ? null : 'next',
    }));
  await renderWithProviders(<StockScreen />);
  await screen.findByRole('button', { name: 'Pepsi lon 330ml' });
  await act(async () =>
    screen.getByTestId('stock-list').props.refreshControl.props.onRefresh(),
  );
  expect(list).toHaveBeenCalledTimes(2);
  await act(async () => screen.getByTestId('stock-list').props.onEndReached());
  expect(
    await screen.findByRole('button', { name: 'Coca-Cola lon 330ml' }),
  ).toBeOnTheScreen();
  expect(list).toHaveBeenLastCalledWith({ status: 'all', cursor: 'next' });
  await act(async () => screen.getByTestId('stock-list').props.onEndReached());
  expect(list).toHaveBeenCalledTimes(3);
});

test('English segment returns to products', async () => {
  useSettingsStore.setState({ language: 'en' });
  await renderWithProviders(<StockScreen />);
  expect(screen.getByRole('radio', { name: 'Stock' })).toBeChecked();
  await fireEvent.press(screen.getByRole('radio', { name: 'Products' }));
  expect(router.replace).toHaveBeenCalledWith('/inventory');
});

test('offline with nothing cached says so with a retry instead of a spinner (#246)', async () => {
  await renderOffline(<StockScreen />);
  expect(await screen.findByTestId('stock-offline')).toBeOnTheScreen();
  expect(
    screen.getByText(
      'Không tải được tồn kho. Không có mạng, danh sách sẽ tải khi có mạng.',
    ),
  ).toBeOnTheScreen();
  expect(screen.queryByLabelText('Đang tải')).toBeNull();
  expect(screen.getByRole('button', { name: 'Thử lại' })).toBeOnTheScreen();
  await act(async () => onlineManager.setOnline(true));
  expect(
    await screen.findByRole('button', { name: 'Coca-Cola lon 330ml' }),
  ).toBeOnTheScreen();
  expect(screen.queryByTestId('stock-offline')).toBeNull();
});
