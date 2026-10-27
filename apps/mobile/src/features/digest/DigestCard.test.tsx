import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import * as digestApi from '@/lib/api/digest';
import type { Digest } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { formatVnd } from '@/lib/format';

import { DigestCard } from './DigestCard';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

afterEach(() => jest.restoreAllMocks());
beforeEach(() => jest.clearAllMocks());

const mockDigest: Digest = {
  business_date: '2026-10-26',
  generated_at: '2026-10-26T07:00:00Z',
  source: 'template',
  summary_vi: 'Doanh thu hôm qua là 1.500.000 ₫. Cần nhập 3 món.',
  sales: {
    revenue: 1500000,
    sale_count: 30,
    gross_profit: 450000,
    change_pct: 10,
  },
  restock: [
    {
      product_id: 'p-1',
      name: 'Coca lon',
      quantity: 24,
      unit_cost: 8000,
      total_cost: 192000,
    },
    {
      product_id: 'p-2',
      name: 'Mì Hảo Hảo',
      quantity: 10,
      unit_cost: 4000,
      total_cost: 40000,
    },
  ],
  overdue_debts: {
    count: 2,
    total: 350000,
  },
  open_drafts: {
    count: 1,
  },
  read_at: null,
};

test('renders nothing while loading or on error or when null', async () => {
  // Never resolving -> loading
  jest
    .spyOn(digestApi, 'getDigest')
    .mockImplementation(() => new Promise(() => {}));
  await renderWithProviders(<DigestCard />);
  expect(screen.queryByText('Tóm tắt sáng nay')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();

  // Error
  jest
    .spyOn(digestApi, 'getDigest')
    .mockRejectedValue(new Error('Network failure'));
  await renderWithProviders(<DigestCard />);
  expect(screen.queryByText('Tóm tắt sáng nay')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test('renders summary, revenue, badge when unread and navigates on tap', async () => {
  jest.spyOn(digestApi, 'getDigest').mockResolvedValue(mockDigest);

  await renderWithProviders(<DigestCard />);

  expect(await screen.findByText('Tóm tắt sáng nay')).toBeOnTheScreen();
  expect(screen.getByText('Mới')).toBeOnTheScreen();
  expect(
    screen.getByText('Doanh thu hôm qua là 1.500.000 ₫.'),
  ).toBeOnTheScreen();
  expect(screen.getByText(formatVnd(1500000))).toBeOnTheScreen();
  expect(screen.getByText('2 cần nhập · 2 nợ quá hạn')).toBeOnTheScreen();

  const button = screen.getByRole('button');
  expect(button.props.accessibilityLabel).toBe(
    `Tóm tắt sáng nay, ${formatVnd(1500000)}, 2 cần nhập · 2 nợ quá hạn`,
  );

  fireEvent.press(button);
  expect(router.push).toHaveBeenCalledWith('/digest?entry=card');
});

test('renders without Mới badge when already read', async () => {
  jest.spyOn(digestApi, 'getDigest').mockResolvedValue({
    ...mockDigest,
    read_at: '2026-10-26T08:00:00Z',
  });

  await renderWithProviders(<DigestCard />);

  expect(await screen.findByText('Tóm tắt sáng nay')).toBeOnTheScreen();
  expect(screen.queryByText('Mới')).toBeNull();
});

test('hides zero parts in caption and adapts accessibility label', async () => {
  jest.spyOn(digestApi, 'getDigest').mockResolvedValue({
    ...mockDigest,
    restock: [],
    overdue_debts: { count: 0, total: 0 },
  });

  await renderWithProviders(<DigestCard />);

  expect(await screen.findByText('Tóm tắt sáng nay')).toBeOnTheScreen();
  expect(screen.queryByText(/cần nhập/)).toBeNull();
  expect(screen.queryByText(/nợ quá hạn/)).toBeNull();

  const button = screen.getByRole('button');
  expect(button.props.accessibilityLabel).toBe(
    `Tóm tắt sáng nay, ${formatVnd(1500000)}, Doanh thu hôm qua là 1.500.000 ₫.`,
  );
});
