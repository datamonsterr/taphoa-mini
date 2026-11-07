import { fireEvent, screen } from '@testing-library/react-native';
import { renderWithProviders } from '@/test/render';
import { ReceiptPriceKeypad, ReceiptPricePill } from './ReceiptPrice';

test('price pill opens editing and signals unknown price', async () => {
  const onPress = jest.fn();
  await renderWithProviders(
    <ReceiptPricePill name="Coca" price={0} onPress={onPress} />,
  );
  const pill = screen.getByRole('button', {
    name: 'Giá nhập: Coca, 0đ, chạm để sửa',
  });
  expect(pill).toHaveStyle({ height: 40 });
  expect(pill.props.hitSlop).toBe(8);
  await fireEvent.press(pill);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('keypad edits unit price, deletes to zero and finishes', async () => {
  const onChange = jest.fn();
  const onDone = jest.fn();
  await renderWithProviders(
    <ReceiptPriceKeypad
      name="Coca"
      price={0}
      onChange={onChange}
      onDone={onDone}
    />,
  );
  await fireEvent.press(screen.getByRole('button', { name: '5' }));
  expect(onChange).toHaveBeenLastCalledWith(5);
  await fireEvent.press(screen.getByRole('button', { name: 'Xóa' }));
  expect(onChange).toHaveBeenLastCalledWith(0);
  await fireEvent.press(screen.getByRole('button', { name: 'Xong' }));
  expect(onDone).toHaveBeenCalledTimes(1);
});

test('keypad limits prices to nine digits', async () => {
  const onChange = jest.fn();
  await renderWithProviders(
    <ReceiptPriceKeypad
      name="Coca"
      price={999999999}
      onChange={onChange}
      onDone={jest.fn()}
    />,
  );
  await fireEvent.press(screen.getByRole('button', { name: '1' }));
  expect(onChange).toHaveBeenLastCalledWith(999999999);
});
