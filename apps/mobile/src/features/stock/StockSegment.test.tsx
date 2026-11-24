import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { StockSegment } from './StockSegment';

test('switching segments calls onSelect', async () => {
  const onSelect = jest.fn();
  await renderWithProviders(
    <StockSegment selected="products" onSelect={onSelect} />,
  );
  expect(screen.getByRole('radio', { name: 'Sản phẩm' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Tồn kho' })).not.toBeChecked();

  await fireEvent.press(screen.getByRole('radio', { name: 'Tồn kho' }));
  expect(onSelect).toHaveBeenCalledWith('stock');
});

test('selected segment is checked', async () => {
  await renderWithProviders(
    <StockSegment selected="stock" onSelect={jest.fn()} />,
  );
  expect(screen.getByRole('radio', { name: 'Tồn kho' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Sản phẩm' })).not.toBeChecked();
});
