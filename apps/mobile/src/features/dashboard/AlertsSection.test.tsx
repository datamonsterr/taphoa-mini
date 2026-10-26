import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import * as stockApi from '@/lib/api/stock';
import * as ledger from '@/lib/api/ledger';
import { testSession, setTestMembership } from '@/test/session';
import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';
import type { StockItem } from '@/lib/api';

import { AlertsSection } from './AlertsSection';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
afterEach(() => jest.restoreAllMocks());
beforeEach(() => jest.clearAllMocks());

const items: StockItem[] = Array.from({ length: 7 }, (_, i) => ({
  product_id: `product-${i}`,
  name: i === 0 ? 'Coca-Cola lon' : `Món ${i}`,
  stock_quantity: i === 0 ? -1 : 3,
  low_stock_threshold: 5,
  status: i === 0 ? 'out' : 'low',
  image_url: null,
  updated_at: '2026-10-25T00:00:00Z',
}));
function seed() {
  jest
    .spyOn(stockApi, 'listStock')
    .mockImplementation(async ({ status } = {}) => ({
      items: items.filter((i) => i.status === status),
      next_cursor: null,
    }));
}

test('shows at most five low/out items, quantity and status color; opens all stock', async () => {
  seed();
  await renderWithProviders(<AlertsSection />);
  expect(await screen.findByText('Sắp hết hàng')).toBeOnTheScreen();
  expect(await screen.findByText('Coca-Cola lon')).toBeOnTheScreen();
  expect(screen.getByText('Hết hàng · -1 còn lại')).toHaveStyle({
    color: colors.danger,
  });
  expect(screen.getAllByText('Sắp hết · 3 còn lại')[0]).toHaveStyle({
    color: colors.warning,
  });
  expect(screen.getByText('Món 4')).toBeOnTheScreen();
  expect(screen.queryByText('Món 5')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Xem tất cả' }));
  expect(router.push).toHaveBeenCalledWith('/stock');
});

test('stock alerts remain visible to Sellers without querying Lead-only margin alerts', async () => {
  seed();
  const session = testSession();
  setTestMembership({
    ...session,
    member: { ...session.member, role: 'seller' },
  });
  const margin = jest.spyOn(ledger, 'listAlerts');
  await renderWithProviders(<AlertsSection />);
  expect(await screen.findByText('Coca-Cola lon')).toBeOnTheScreen();
  expect(margin).not.toHaveBeenCalled();
});

test('stock list survives a margin failure and has its own retry on stock failure', async () => {
  seed();
  jest.spyOn(ledger, 'listAlerts').mockRejectedValue(new Error('offline'));
  await renderWithProviders(<AlertsSection />);
  expect(await screen.findByText('Coca-Cola lon')).toBeOnTheScreen();
  expect(await screen.findByText('Không tải được cảnh báo')).toBeOnTheScreen();
});

test('stock query failure offers a retry rather than an empty list', async () => {
  const spy = jest
    .spyOn(stockApi, 'listStock')
    .mockRejectedValue(new Error('offline'));
  await renderWithProviders(<AlertsSection />);
  const retry = await screen.findByRole('button', {
    name: 'Không tải được tồn kho, Thử lại',
  });
  spy.mockResolvedValue({ items: [items[0]!], next_cursor: null });
  await fireEvent.press(retry);
  expect(await screen.findByText('Coca-Cola lon')).toBeOnTheScreen();
});

test('hides the stock list when there are no low or out products', async () => {
  jest
    .spyOn(stockApi, 'listStock')
    .mockResolvedValue({ items: [], next_cursor: null });
  await renderWithProviders(<AlertsSection />);
  await screen.findByRole('button', { name: /món giá bán dưới giá nhập/ });
  expect(screen.queryByText('Sắp hết hàng')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Xem tất cả' })).toBeNull();
});
