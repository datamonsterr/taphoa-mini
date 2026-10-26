import { render, screen } from '@testing-library/react-native';

import { RestockListCard } from './RestockListCard';

const item = (over = {}) => ({
  product_id: 'p1',
  name: 'Mì Hảo Hảo',
  quantity: 12,
  unit_cost: 3500,
  total_cost: 42000,
  ...over,
});

test('shows quantity, unit cost, line cost and total', async () => {
  await render(
    <RestockListCard
      card={{ type: 'restock_list', items: [item()], total_cost: 42000 }}
    />,
  );
  expect(screen.getByText('Mì Hảo Hảo')).toBeTruthy();
  expect(screen.getByText('12')).toBeTruthy();
  expect(screen.getByText('3.500đ')).toBeTruthy();
  expect(screen.getAllByText('42.000đ')).toHaveLength(2);
});

test('hides costs the member cannot see', async () => {
  await render(
    <RestockListCard
      card={{
        type: 'restock_list',
        items: [item({ unit_cost: null, total_cost: null })],
        total_cost: null,
      }}
    />,
  );
  expect(screen.getByText('Mì Hảo Hảo')).toBeTruthy();
  expect(screen.queryByText(/đ$/)).toBeNull();
});
