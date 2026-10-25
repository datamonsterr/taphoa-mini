import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderWithProviders } from '@/test/render';
import * as debtsApi from '@/lib/api/debts';
import { createCustomer, listCustomers } from '@/lib/api/debts';
import { newUuid } from '@/lib/uuid';
import { CustomerPicker } from './CustomerPicker';

test('shows recent customers, searches name/phone and selects a customer', async () => {
  const lan = await createCustomer({
    id: newUuid(),
    name: 'Lan',
    phone: '0901234567',
  });
  await createCustomer({ id: newUuid(), name: 'Mai' });
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

afterEach(() => jest.restoreAllMocks());

test('pressing create again after a lost response resends the same id', async () => {
  const real = debtsApi.createCustomer;
  const create = jest
    .spyOn(debtsApi, 'createCustomer')
    .mockImplementationOnce(async (input) => {
      await real(input);
      throw new TypeError('response lost');
    });
  const onSelect = jest.fn();
  await renderWithProviders(
    <CustomerPicker onSelect={onSelect} onClose={jest.fn()} />,
  );
  await fireEvent.changeText(screen.getByLabelText('Tên khách hàng'), 'Cô Hoa');
  await fireEvent.press(screen.getByLabelText('Tạo khách hàng'));
  expect(
    await screen.findByText('Không tạo được khách hàng. Thử lại.'),
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('Tạo khách hàng'));
  await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]![0].id).toBe(create.mock.calls[0]![0].id);
  expect((await listCustomers({ query: 'Hoa' })).items).toHaveLength(1);
});
