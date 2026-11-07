import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderWithProviders } from '@/test/render';
import { PRODUCT_IDS } from '@/test/mock/fixtures';
import { getProduct } from '@/lib/api/products';
import { formatVnd } from '@/lib/format';
import { getApiClient } from '@/lib/api/client';
import { UnitForm, UnitsEditor, UnitsRow } from './UnitsEditor';

afterEach(() => jest.restoreAllMocks());
test('units page: base row with its price, extra units as pills, add opens the form', async () => {
  const product = await getProduct(PRODUCT_IDS.coca);
  await renderWithProviders(
    <UnitsEditor product={product} onClose={jest.fn()} />,
  );
  expect(screen.getByRole('header', { name: 'Đơn vị bán' })).toBeOnTheScreen();
  expect(
    screen.getByText(`${product.base_unit} · ${formatVnd(product.price)}`),
  ).toBeOnTheScreen();
  expect(screen.getByText('Đơn vị gốc')).toBeOnTheScreen();
  const unit = product.units[0]!;
  expect(
    screen.getByText(
      `${unit.name} · ${unit.quantity_in_base} ${product.base_unit} · ${formatVnd(unit.price)} · Sửa`,
    ),
  ).toBeOnTheScreen();
  expect(screen.queryByTestId('unit-form')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Thêm đơn vị' }));
  expect(screen.getByTestId('unit-form')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Lưu đơn vị' })).toBeDisabled();
  expect(
    screen.getByLabelText(`Số ${product.base_unit} trong một đơn vị`),
  ).toBeOnTheScreen();
  expect(screen.getByText(/^Lead thêm\/sửa\/xóa đơn vị phụ/)).toBeOnTheScreen();
});
test('editing a unit shows its form under it', async () => {
  const product = await getProduct(PRODUCT_IDS.coca);
  const unit = product.units[0]!;
  await renderWithProviders(
    <UnitsEditor product={product} onClose={jest.fn()} />,
  );
  await fireEvent.press(
    screen.getByRole('button', { name: `Sửa đơn vị ${unit.name}` }),
  );
  expect(screen.getByLabelText('Tên đơn vị').props.value).toBe(unit.name);
  expect(screen.getByRole('button', { name: 'Xóa đơn vị' })).toBeOnTheScreen();
});
test('the back pill closes the page', async () => {
  const product = await getProduct(PRODUCT_IDS.coca);
  const close = jest.fn();
  await renderWithProviders(<UnitsEditor product={product} onClose={close} />);
  await fireEvent.press(
    screen.getByRole('button', { name: `Quay lại ${product.name}` }),
  );
  expect(close).toHaveBeenCalled();
});
test('board 09 row: the Lead opens the page from "Đơn vị bán · chai / lốc · Sửa", a seller only reads it', async () => {
  const product = await getProduct(PRODUCT_IDS.coca);
  const names = [product.base_unit, ...product.units.map((u) => u.name)].join(
    ' / ',
  );
  const { unmount } = await renderWithProviders(
    <UnitsRow product={product} isLead />,
  );
  expect(screen.getByText(`Đơn vị bán · ${names} · Sửa`)).toBeOnTheScreen();
  expect(screen.queryByTestId('units-page')).toBeNull();
  await fireEvent.press(
    screen.getByRole('button', { name: `Sửa đơn vị bán: ${names}` }),
  );
  expect(screen.getByTestId('units-page')).toBeOnTheScreen();
  await unmount();
  await renderWithProviders(<UnitsRow product={product} isLead={false} />);
  expect(screen.getByText(`Đơn vị bán · ${names}`)).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: /Sửa đơn vị bán/ })).toBeNull();
});
test('creates an extra unit, retaining existing ones', async () => {
  const product = await getProduct(PRODUCT_IDS.coca);
  const close = jest.fn();
  await renderWithProviders(<UnitForm product={product} onClose={close} />);
  await fireEvent.changeText(screen.getByLabelText('Tên đơn vị'), 'lốc');
  await fireEvent.changeText(
    screen.getByLabelText(`Số ${product.base_unit} trong một đơn vị`),
    '1',
  );
  await fireEvent.changeText(screen.getByLabelText('Giá bán (đ)'), '55000');
  expect(screen.getByRole('button', { name: 'Lưu đơn vị' })).toBeDisabled();
  await fireEvent.changeText(
    screen.getByLabelText(`Số ${product.base_unit} trong một đơn vị`),
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
    <UnitForm product={product} unit={unit} onClose={close} />,
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
    <UnitForm product={product} unit={unit} onClose={close} />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Xóa đơn vị' }));
  expect((await getProduct(product.id)).units).toEqual(product.units);
  await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận xóa' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  const updated = await getProduct(product.id);
  expect(updated.units).toEqual(product.units.filter((u) => u.id !== unit.id));
  expect(updated.price).toBe(product.price);
});
