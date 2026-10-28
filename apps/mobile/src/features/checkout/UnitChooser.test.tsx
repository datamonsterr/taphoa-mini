import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderWithProviders } from '@/test/render';
import { PRODUCT_IDS } from '@/test/mock/fixtures';
import { getProduct } from '@/lib/api/products';
import { cartLineKey, useCartStore } from '@/stores/cart';
import { formatVnd } from '@/lib/format';
import { UnitChooser } from './UnitChooser';

function CartChoice() {
  const line = useCartStore((s) => s.lines[0]);
  return line ? <UnitChooser line={line} /> : null;
}
test('cart chooser switches unit ID and price, then returns to base', async () => {
  const product = await getProduct(PRODUCT_IDS.coca);
  const unit = product.units[0]!;
  useCartStore
    .getState()
    .add({ productId: product.id, name: product.name!, price: product.price });
  await renderWithProviders(<CartChoice />);
  const label = `${unit.name}, ${formatVnd(unit.price)}, Chọn đơn vị`;
  await fireEvent.press(await screen.findByRole('radio', { name: label }));
  await waitFor(() =>
    expect(useCartStore.getState().lines[0]).toMatchObject({
      unitId: unit.id,
      price: unit.price,
      qty: 1,
    }),
  );
  expect(screen.getByRole('radio', { name: label })).toBeChecked();
  await fireEvent.press(
    screen.getByRole('radio', {
      name: `${product.base_unit}, ${formatVnd(product.price)}, Chọn đơn vị`,
    }),
  );
  expect(useCartStore.getState().lines[0]).toMatchObject({
    unitId: undefined,
    price: product.price,
  });
});
test('store keeps base and pack separate, and merges matching units when changed', () => {
  const state = useCartStore.getState();
  state.add({ productId: 'p', name: 'Cola', price: 10000 });
  state.add({ productId: 'p', name: 'Cola', price: 55000, unitId: 'pack' });
  state.add({ productId: 'p', name: 'Cola', price: 55000, unitId: 'pack' });
  expect(useCartStore.getState().lines).toHaveLength(2);
  state.increment('p:pack');
  state.decrement('p:pack');
  expect(useCartStore.getState().lines.map((l) => l.qty)).toEqual([1, 2]);
  state.setUnit(cartLineKey(useCartStore.getState().lines[0]!), {
    id: 'pack',
    name: 'lốc',
    price: 55000,
  });
  expect(useCartStore.getState().lines).toHaveLength(1);
  expect(useCartStore.getState().lines[0]!.qty).toBe(3);
  state.remove('p:pack');
  expect(useCartStore.getState().lines).toEqual([]);
});
