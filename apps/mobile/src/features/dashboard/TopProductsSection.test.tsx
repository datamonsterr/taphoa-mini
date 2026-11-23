import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import { resetApiClient } from '@/lib/api';
import * as ledger from '@/lib/api/ledger';
import type { TopProduct } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { resetMockDb } from '@/test/mock';
import { renderWithProviders } from '@/test/render';

import { TopProductsSection } from './TopProductsSection';
import { currentRange } from './useDashboardData';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

beforeEach(() => {
  resetMockDb();
  resetApiClient();
  jest.clearAllMocks();
});
afterEach(() => jest.restoreAllMocks());

const top = (i: number, over: Partial<TopProduct> = {}): TopProduct => ({
  product_id: `00000000-0000-4000-8000-00000000000${i}`,
  name: `Món ${i}`,
  quantity: 10 - i,
  revenue: 100_000 - i * 1_000,
  ...over,
});

const EMPTY = 'Chưa có món nào bán trong kỳ này';

test('lists the top five with quantity and revenue; a row opens the product', async () => {
  const spy = jest
    .spyOn(ledger, 'getTopProducts')
    .mockResolvedValue(Array.from({ length: 5 }, (_, i) => top(i + 1)));
  await renderWithProviders(<TopProductsSection period="day" />);
  expect(
    await screen.findByRole('header', { name: 'Bán chạy' }),
  ).toBeOnTheScreen();
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({ limit: 5, sort: 'revenue' }),
  );
  const row = await screen.findByRole('button', {
    name: `Món 1, 9 đã bán, ${formatVnd(99_000)}`,
  });
  expect(screen.getAllByRole('button')).toHaveLength(5);
  await fireEvent.press(row);
  expect(router.push).toHaveBeenCalledWith(
    '/product/00000000-0000-4000-8000-000000000001',
  );
});

test('asks for the range of the selected period', async () => {
  const spy = jest.spyOn(ledger, 'getTopProducts').mockResolvedValue([]);
  const day = await renderWithProviders(<TopProductsSection period="day" />);
  await screen.findByText(EMPTY);
  const dayRange = spy.mock.calls[0]![0];
  expect(dayRange.from).toBe(dayRange.to);
  day.unmount();
  await renderWithProviders(<TopProductsSection period="month" />);
  await screen.findByText(EMPTY);
  const monthRange = spy.mock.calls.at(-1)![0];
  expect(monthRange.to).toBe(dayRange.to);
  expect(monthRange.from.endsWith('-01')).toBe(true);
});

test('shows an empty state when nothing sold', async () => {
  jest.spyOn(ledger, 'getTopProducts').mockResolvedValue([]);
  await renderWithProviders(<TopProductsSection period="day" />);
  expect(await screen.findByText(EMPTY)).toBeOnTheScreen();
});

test('shows a skeleton while loading', async () => {
  jest
    .spyOn(ledger, 'getTopProducts')
    .mockReturnValue(new Promise<TopProduct[]>(() => {}));
  await renderWithProviders(<TopProductsSection period="day" />);
  expect(screen.getByTestId('top-products-skeleton')).toBeOnTheScreen();
});

test('a failed load says so and retries', async () => {
  const spy = jest
    .spyOn(ledger, 'getTopProducts')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([top(1)]);
  await renderWithProviders(<TopProductsSection period="day" />);
  expect(
    await screen.findByText('Không tải được món bán chạy'),
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  expect(await screen.findByText('Món 1')).toBeOnTheScreen();
  expect(spy).toHaveBeenCalledTimes(2);
});

test('the seeded shop ranks its best seller first, through the mock server', async () => {
  await renderWithProviders(<TopProductsSection period="day" />);
  const [first] = await ledger.getTopProducts({
    ...currentRange('day'),
    sort: 'revenue',
    limit: 5,
  });
  expect(first?.name).toBeTruthy();
  expect(await screen.findByText(first!.name!)).toBeOnTheScreen();
});
