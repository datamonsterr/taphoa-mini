import { fireEvent, screen } from '@testing-library/react-native';
import { renderWithProviders } from '@/test/render';
import { ReceiptQuantityStepper } from './ReceiptQuantityStepper';

test('minus stays at one; plus and minus change quantity with 56px targets', async () => {
  const onChange = jest.fn();
  const { rerender } = await renderWithProviders(
    <ReceiptQuantityStepper name="Coca" value={1} onChange={onChange} />,
  );
  const minus = screen.getByRole('button', { name: 'Bớt một: Coca' });
  expect(minus).toBeDisabled();
  expect(minus).toHaveStyle({ width: 56, height: 56 });
  await fireEvent.press(minus);
  expect(onChange).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Thêm một: Coca' }));
  expect(onChange).toHaveBeenLastCalledWith(2);
  await rerender(
    <ReceiptQuantityStepper name="Coca" value={2} onChange={onChange} />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Bớt một: Coca' }));
  expect(onChange).toHaveBeenLastCalledWith(1);
});

test('maximum quantities cannot be incremented', async () => {
  await renderWithProviders(
    <ReceiptQuantityStepper
      name="Coca"
      value={2147483647}
      onChange={jest.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Thêm một: Coca' })).toBeDisabled();
});

test('busy controls cannot change quantity', async () => {
  const onChange = jest.fn();
  await renderWithProviders(
    <ReceiptQuantityStepper
      name="Coca"
      value={2}
      disabled
      onChange={onChange}
    />,
  );
  for (const name of ['Bớt một: Coca', 'Thêm một: Coca']) {
    const control = screen.getByRole('button', { name });
    expect(control).toBeDisabled();
    await fireEvent.press(control);
  }
  expect(onChange).not.toHaveBeenCalled();
});
