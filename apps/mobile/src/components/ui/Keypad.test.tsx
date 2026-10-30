import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { Keypad, KeypadKey } from './Keypad';

test('renders 12 labelled keys with Xóa for delete', async () => {
  await renderWithProviders(<Keypad onKey={jest.fn()} />);
  expect(screen.getAllByRole('button')).toHaveLength(12);
  for (const label of ['1', '9', '000', '0', 'Xóa']) {
    expect(screen.getByRole('button', { name: label })).toBeOnTheScreen();
  }
});

test('reports the pressed key id', async () => {
  const onKey = jest.fn();
  await renderWithProviders(<Keypad onKey={onKey} />);
  await fireEvent.press(screen.getByRole('button', { name: '7' }));
  await fireEvent.press(screen.getByRole('button', { name: '000' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Xóa' }));
  expect(onKey.mock.calls.map(([k]) => k)).toEqual(['7', '000', 'delete']);
});

test('disabled keypad ignores presses', async () => {
  const onKey = jest.fn();
  await renderWithProviders(<Keypad onKey={onKey} disabled diameter={68} />);
  await fireEvent.press(screen.getByRole('button', { name: '1' }));
  expect(onKey).not.toHaveBeenCalled();
});

test('single key renders its digit', async () => {
  await renderWithProviders(<KeypadKey keyId="5" onPress={jest.fn()} />);
  expect(screen.getByText('5')).toBeOnTheScreen();
});

test('labels override the delete key name', async () => {
  await renderWithProviders(
    <Keypad onKey={jest.fn()} labels={{ delete: 'Delete' }} />,
  );
  expect(screen.getByRole('button', { name: 'Delete' })).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Xóa' })).toBeNull();
});

test('lays the keys out as the board does: 4 rows of 3', async () => {
  await renderWithProviders(<Keypad onKey={jest.fn()} />);
  const rows = screen.getByTestId('keypad').children;
  expect(rows).toHaveLength(4);
  expect(
    rows.map((row) => (typeof row === 'string' ? 0 : row.children.length)),
  ).toEqual([3, 3, 3, 3]);
});
