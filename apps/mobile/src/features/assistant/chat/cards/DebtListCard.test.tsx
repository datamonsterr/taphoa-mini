import { render, screen } from '@testing-library/react-native';

import { useSettingsStore } from '@/stores/settings';

import { DebtListCard } from './DebtListCard';

const card = {
  type: 'debt_list' as const,
  items: [
    { customer_id: 'c1', name: 'Chị Lan', total: 250000, overdue_days: 12 },
    { customer_id: 'c2', name: 'Anh Bình', total: 40000, overdue_days: 0 },
  ],
};

test('shows name, total and overdue days', async () => {
  await render(<DebtListCard card={card} />);
  expect(screen.getByText('Chị Lan')).toBeTruthy();
  expect(screen.getByText('250.000đ')).toBeTruthy();
  expect(screen.getByText('Quá hạn 12 ngày')).toBeTruthy();
  expect(screen.queryByText(/Quá hạn 0/)).toBeNull();
});

test('overdue days in English', async () => {
  useSettingsStore.setState({ language: 'en' });
  await render(<DebtListCard card={card} />);
  expect(screen.getByText('12 days overdue')).toBeTruthy();
});
