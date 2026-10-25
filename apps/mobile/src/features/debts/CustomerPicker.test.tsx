import { fireEvent, screen } from '@testing-library/react-native';
import { renderWithProviders } from '@/test/render';
import { createCustomer } from '@/lib/api/debts';
import { CustomerPicker } from './CustomerPicker';

test('shows recent customers, searches name/phone and selects a customer', async () => {
  const lan = await createCustomer({ name: 'Lan', phone: '0901234567' });
  await createCustomer({ name: 'Mai' });
  const onSelect = jest.fn();
  await renderWithProviders(
    <CustomerPicker onSelect={onSelect} onClose={jest.fn()} />,
  );
  expect(await screen.findByText('Khách gần đây')).toBeOnTheScreen();
  expect(await screen.findByText('Mai')).toBeOnTheScreen();
  await fireEvent.changeText(screen.getByLabelText('Tìm khách hàng'), '0901');
  expect(await screen.findByText('Lan')).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('Lan, 0đ'));
  expect(onSelect).toHaveBeenCalledWith(lan);
});

test('creates inline with name and optional phone then selects', async () => {
  const onSelect = jest.fn();
  await renderWithProviders(
    <CustomerPicker onSelect={onSelect} onClose={jest.fn()} />,
  );
  await fireEvent.changeText(screen.getByLabelText('Tên khách hàng'), 'Cô Hoa');
  await fireEvent.changeText(
    screen.getByLabelText('Số điện thoại (không bắt buộc)'),
    '0912345678',
  );
  await fireEvent.press(screen.getByLabelText('Tạo khách hàng'));
  await screen.findByText('Cô Hoa');
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Cô Hoa', phone: '0912345678' }),
  );
});
