import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { PayToggle } from './PayToggle';

test('transfer selected', async () => {
  await renderWithProviders(
    <PayToggle value="transfer" onChange={jest.fn()} />,
  );
  expect(screen.getByLabelText('Cách trả')).toHaveProp(
    'accessibilityRole',
    'radiogroup',
  );
  expect(screen.getByRole('radio', { name: 'Chuyển khoản' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Tiền mặt' })).not.toBeChecked();
});

test('cash selected and switching calls onChange', async () => {
  const onChange = jest.fn();
  const view = await renderWithProviders(
    <PayToggle value="cash" onChange={onChange} />,
  );
  expect(screen.getByRole('radio', { name: 'Tiền mặt' })).toBeChecked();
  await fireEvent.press(screen.getByRole('radio', { name: 'Chuyển khoản' }));
  expect(onChange).toHaveBeenCalledWith('transfer');
  await view.rerender(<PayToggle value="transfer" onChange={onChange} />);
  await fireEvent.press(screen.getByRole('radio', { name: 'Tiền mặt' }));
  expect(onChange).toHaveBeenCalledWith('cash');
});

test('labels override the accessible names', async () => {
  await renderWithProviders(
    <PayToggle
      value="cash"
      onChange={jest.fn()}
      labels={{ group: 'Method', transfer: 'Transfer', cash: 'Cash' }}
    />,
  );
  expect(screen.getByLabelText('Method')).toBeOnTheScreen();
  expect(screen.getByRole('radio', { name: 'Cash' })).toBeChecked();
});

test('each payment method has an icon and visible word with a 56 dp target', async () => {
  await renderWithProviders(<PayToggle value="credit" onChange={jest.fn()} />);
  for (const label of ['Chuyển khoản', 'Tiền mặt', 'Ghi nợ']) {
    expect(screen.getByText(label)).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: label })).toHaveStyle({
      minHeight: 56,
      minWidth: 56,
    });
  }
  expect(screen.getByRole('radio', { name: 'Ghi nợ' })).toBeChecked();
  for (const icon of ['QrCode', 'Banknote', 'BookOpen'])
    expect(screen.getByTestId(`icon-${icon}`)).toBeOnTheScreen();
});

test('icon-only keeps the accessible names but hides the words', async () => {
  await renderWithProviders(
    <PayToggle iconOnly value="cash" onChange={jest.fn()} />,
  );
  expect(screen.queryByText('Tiền mặt')).toBeNull();
  expect(screen.getByRole('radio', { name: 'Tiền mặt' })).toBeChecked();
  expect(screen.getByTestId('icon-Banknote')).toBeOnTheScreen();
});
