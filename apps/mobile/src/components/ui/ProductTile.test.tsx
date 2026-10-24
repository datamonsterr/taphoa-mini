import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { ProductTile } from './ProductTile';

test('normal tile: name, price, labelled for screen readers', async () => {
  const onPress = jest.fn();
  await renderWithProviders(
    <ProductTile name="Sting đỏ" price={10000} onPress={onPress} />,
  );
  const tile = screen.getByRole('button', {
    name: 'Sting đỏ, 10.000đ',
  });
  expect(screen.getByText('Sting đỏ')).toBeOnTheScreen();
  expect(screen.getByText('10.000đ')).toBeOnTheScreen();
  expect(screen.queryByTestId('product-photo')).toBeNull();
  await fireEvent.press(tile);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('renders the photo when given a uri', async () => {
  await renderWithProviders(
    <ProductTile name="Coca" price={10000} imageUri="https://x/coca.jpg" />,
  );
  expect(screen.getByTestId('product-photo')).toBeOnTheScreen();
});

test('photo is cached on disk and recycled by uri', async () => {
  await renderWithProviders(
    <ProductTile name="Coca" price={10000} imageUri="https://x/coca.jpg" />,
  );
  expect(screen.getByTestId('product-photo').props).toMatchObject({
    cachePolicy: 'memory-disk',
    recyclingKey: 'https://x/coca.jpg',
  });
});

test('tracked products show stock and untracked products have no badge', async () => {
  const { rerender } = await renderWithProviders(
    <ProductTile
      name="Coca"
      price={10000}
      stockQuantity={3}
      stockStatus="low"
    />,
  );
  expect(screen.getByLabelText('Tồn kho 3, Sắp hết')).toBeOnTheScreen();
  await rerender(
    <ProductTile
      name="Coca"
      price={10000}
      stockQuantity={null}
      stockStatus="untracked"
    />,
  );
  expect(screen.queryByLabelText(/Tồn kho/)).toBeNull();
});
