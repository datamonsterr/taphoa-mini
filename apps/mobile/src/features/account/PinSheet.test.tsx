import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { applyPinKey, PinSheet } from './PinSheet';

const sheet = () => (
  <PinSheet
    title="Đặt mã PIN"
    confirmLabel="Lưu"
    onSubmit={jest.fn()}
    onClose={jest.fn()}
  />
);

test('the PIN keypad has digits 0-9 and delete, no 000 key', async () => {
  await renderWithProviders(sheet());
  expect(screen.queryByRole('button', { name: '000' })).toBeNull();
  for (const label of ['0', '1', '9', 'Xóa']) {
    expect(screen.getByRole('button', { name: label })).toBeOnTheScreen();
  }
});

test('applyPinKey never adds three digits at once', () => {
  expect(applyPinKey('12', '000')).toBe('12');
  expect(applyPinKey('12', '0')).toBe('120');
  expect(applyPinKey('123456', '7')).toBe('123456');
  expect(applyPinKey('12', 'delete')).toBe('1');
});

test('each tap adds one digit', async () => {
  await renderWithProviders(sheet());
  await fireEvent.press(screen.getByRole('button', { name: '0' }));
  await fireEvent.press(screen.getByRole('button', { name: '4' }));
  expect(screen.getByTestId('pin-sheet-dots')).toHaveTextContent('● ●');
});
