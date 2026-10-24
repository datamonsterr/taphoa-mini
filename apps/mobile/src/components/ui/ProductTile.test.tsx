import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { ProductTile } from './ProductTile';

test('normal tile: name, price, stock, labelled for screen readers', async () => {
  const onPress = jest.fn();
  await renderWithProviders(
    <ProductTile name="Sting đỏ" price={10000} stock={24} onPress={onPress} />,
  );
  const tile = screen.getByRole('button', {
    name: 'Sting đỏ, 10.000đ, còn 24',
  });
  expect(screen.getByText('Sting đỏ')).toBeOnTheScreen();
  expect(screen.getByText('10.000đ')).toBeOnTheScreen();
  expect(screen.queryByTestId('product-photo')).toBeNull();
  await fireEvent.press(tile);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('low stock tile says sắp hết', async () => {
  await renderWithProviders(
    <ProductTile name="Hảo Hảo" price={4500} stock={3} low />,
  );
  expect(
    screen.getByRole('button', { name: 'Hảo Hảo, 4.500đ, sắp hết: còn 3' }),
  ).toBeOnTheScreen();
});

test('renders the photo when given a uri', async () => {
  await renderWithProviders(
    <ProductTile
      name="Coca"
      price={10000}
      stock={18}
      imageUri="https://x/coca.jpg"
    />,
  );
  expect(screen.getByTestId('product-photo')).toBeOnTheScreen();
});

test('photo is cached on disk and recycled by uri', async () => {
  await renderWithProviders(
    <ProductTile
      name="Coca"
      price={10000}
      stock={18}
      imageUri="https://x/coca.jpg"
    />,
  );
  expect(screen.getByTestId('product-photo').props).toMatchObject({
    cachePolicy: 'memory-disk',
    recyclingKey: 'https://x/coca.jpg',
  });
});

test('no stock reported: no badge and no "còn" in the label', async () => {
  await renderWithProviders(<ProductTile name="Sting đỏ" price={10000} />);
  expect(
    screen.getByRole('button', { name: 'Sting đỏ, 10.000đ' }),
  ).toBeOnTheScreen();
  expect(screen.queryByLabelText(/còn/)).toBeNull();
});
