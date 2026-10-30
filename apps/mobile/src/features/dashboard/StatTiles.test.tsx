import { screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { StatTiles } from './StatTiles';

const labels = {
  revenue: 'Doanh thu',
  orders: 'đơn',
  cash: 'Tiền mặt',
  transfer: 'Chuyển khoản',
  expense: 'Chi',
  net: 'Lãi',
};
const totals = (expense: number) => ({
  revenue: 30000,
  salesCount: 2,
  cash: 20000,
  transfer: 10000,
  expense,
  net: 30000 - expense,
});

// Issue 191: a day without expenses read "−0đ" in red.
test('no expenses reads 0đ with no minus sign', async () => {
  await renderWithProviders(<StatTiles totals={totals(0)} labels={labels} />);
  expect(screen.getByLabelText('Chi 0đ')).toBeOnTheScreen();
  expect(screen.getByText('0đ')).toBeOnTheScreen();
  expect(screen.queryByText(/−/)).toBeNull();
  expect(screen.queryByText(/-0/)).toBeNull();
});

test('an expense keeps the minus sign', async () => {
  await renderWithProviders(
    <StatTiles totals={totals(5000)} labels={labels} />,
  );
  expect(screen.getByText('−5.000đ')).toBeOnTheScreen();
});
