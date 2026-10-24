import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import { useLowStockAlerts } from '@/stores/lowStockAlerts';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';

import { LowStockBanner } from './LowStockBanner';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

beforeEach(() => {
  useLowStockAlerts.setState({ alerts: [] });
  jest.clearAllMocks();
});

const alert = (id = 'coca') => ({
  product_id: id,
  name: 'Coca-Cola lon',
  stock_quantity: 3,
  threshold: 5,
  at: '2026-10-25T00:00:00Z',
});

test('stays hidden without alerts; announces a new product and opens stock', async () => {
  await renderWithProviders(<LowStockBanner />);
  expect(screen.queryByRole('alert')).toBeNull();
  await act(() => useLowStockAlerts.getState().push(alert()));
  const message = 'Sắp hết hàng: Coca-Cola lon (3 còn lại)';
  expect(screen.getByRole('alert', { name: message })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: message }));
  expect(router.push).toHaveBeenCalledWith('/stock');
});

test('summarizes several products and dismiss clears every visible alert', async () => {
  for (const id of ['a', 'b', 'c'])
    useLowStockAlerts.getState().push(alert(id));
  await renderWithProviders(<LowStockBanner />);
  expect(screen.getByText('3 sản phẩm sắp hết hàng')).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Đóng cảnh báo tồn kho' }),
  );
  expect(useLowStockAlerts.getState().alerts).toEqual([]);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(router.push).not.toHaveBeenCalled();
});

test('uses a fallback for unnamed products and follows the selected language', async () => {
  useLowStockAlerts
    .getState()
    .push({ ...alert(), name: null, stock_quantity: -1 });
  useSettingsStore.setState({ language: 'en' });
  await renderWithProviders(<LowStockBanner />);
  expect(
    screen.getByText('Low stock: Unnamed product (-1 remaining)'),
  ).toBeOnTheScreen();
});
