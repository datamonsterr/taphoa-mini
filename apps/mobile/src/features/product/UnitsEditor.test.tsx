import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderWithProviders } from '@/test/render';
import { PRODUCT_IDS } from '@/test/mock/fixtures';
import { getProduct } from '@/lib/api/products';
import { getApiClient } from '@/lib/api/client';
import { UnitsEditor, UnitSheet } from './UnitsEditor';

afterEach(() => jest.restoreAllMocks());
test('lists base and extra units and opens add sheet', async () => {
  const product = await getProduct(PRODUCT_IDS.coca);
  await renderWithProviders(<UnitsEditor product={product} />);
  expect(
    screen.getByText(`${product.base_unit} · Đơn vị gốc`),
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Thêm đơn vị' }));
  expect(screen.getByTestId('unit-sheet')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Lưu đơn vị' })).toBeDisabled();
});
test('creates an extra unit, retaining existing ones', async () => {
  const product = await getProduct(PRODUCT_IDS.coca);
  const close = jest.fn();
  await renderWithProviders(<UnitSheet product={product} onClose={close} />);
  await fireEvent.changeText(screen.getByLabelText('Tên đơn vị'), 'lốc');
  await fireEvent.changeText(
    screen.getByLabelText(`Số đơn vị gốc (${product.base_unit})`),
    '1',
  );
  await fireEvent.changeText(screen.getByLabelText('Giá bán (đ)'), '55000');
  expect(screen.getByRole('button', { name: 'Lưu đơn vị' })).toBeDisabled();
  await fireEvent.changeText(
    screen.getByLabelText(`Số đơn vị gốc (${product.base_unit})`),
    '6',
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu đơn vị' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  const updated = await getProduct(product.id);
  expect(updated.units).toEqual(
    expect.arrayContaining([
      ...product.units,
      expect.objectContaining({
        name: 'lốc',
        quantity_in_base: 6,
        price: 55000,
      }),
    ]),
  );
});
test('edits name/price and preserves barcode; errors retain input for retry', async () => {
  const product = await getProduct(PRODUCT_IDS.coca);
  const unit = { ...product.units[0]!, barcode: '893000000' };
  const request = jest
    .spyOn(getApiClient(), 'updateProductUnit')
    .mockRejectedValueOnce(new Error('offline'));
  const close = jest.fn();
  await renderWithProviders(
    <UnitSheet product={product} unit={unit} onClose={close} />,
  );
  await fireEvent.changeText(screen.getByLabelText('Giá bán (đ)'), '225000');
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu đơn vị' }));
  await screen.findByText('Chưa lưu được đơn vị. Thử lại.');
  expect(screen.getByLabelText('Giá bán (đ)').props.value).toBe('225000');
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu đơn vị' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(request).toHaveBeenLastCalledWith(product.id, product.units, {
    ...unit,
    price: 225000,
  });
});
test('deletion requires confirmation and leaves the base price', async () => {
  const product = await getProduct(PRODUCT_IDS.coca);
  const unit = product.units[0]!;
  const close = jest.fn();
  await renderWithProviders(
    <UnitSheet product={product} unit={unit} onClose={close} />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Xóa đơn vị' }));
  expect((await getProduct(product.id)).units).toEqual(product.units);
  await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận xóa' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  const updated = await getProduct(product.id);
  expect(updated.units).toEqual(product.units.filter((u) => u.id !== unit.id));
  expect(updated.price).toBe(product.price);
});
