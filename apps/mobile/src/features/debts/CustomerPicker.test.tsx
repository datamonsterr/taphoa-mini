import { Contact } from 'expo-contacts';
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
  expect(
    screen.getByRole('header', { name: 'Chọn khách hàng' }),
  ).toBeOnTheScreen();
  expect(screen.getByText('0901234567')).toBeOnTheScreen();
  expect(screen.getByText('2 khách')).toBeOnTheScreen();
  // settled customers show no activity age: the API has no last-activity date
  expect(screen.queryByText(/hôm nay|hôm qua|ngày|tuần/)).toBeNull();
  expect(screen.getAllByText('Hết nợ')).toHaveLength(2);
  expect(screen.getByText('Không có số')).toBeOnTheScreen();
  expect(screen.getByText('L')).toBeOnTheScreen();
  expect(
    screen.getByPlaceholderText('Tên hoặc số điện thoại'),
  ).toBeOnTheScreen();
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
  await fireEvent.press(screen.getByLabelText('Tạo và ghi nợ'));
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
  await fireEvent.press(screen.getByLabelText('Tạo và ghi nợ'));
  expect(
    await screen.findByText('Không tạo được khách hàng. Thử lại.'),
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('Tạo và ghi nợ'));
  await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]![0].id).toBe(create.mock.calls[0]![0].id);
  expect((await listCustomers({ query: 'Hoa' })).items).toHaveLength(1);
});

test('the contact picker fills only the chosen name and phone, then calls onCreate', async () => {
  const getFullName = jest.fn().mockResolvedValue('Chị Hạnh');
  const getPhones = jest.fn().mockResolvedValue([{ number: '0909876543' }]);
  (Contact.presentPicker as jest.Mock).mockResolvedValueOnce({
    getFullName,
    getPhones,
  });
  const onCreate = jest.fn();
  const onSelect = jest.fn();
  await renderWithProviders(
    <CustomerPicker
      mode="create"
      onCreate={onCreate}
      onSelect={onSelect}
      onClose={jest.fn()}
    />,
  );
  expect(
    screen.getByRole('header', { name: 'Thêm khách hàng' }),
  ).toBeOnTheScreen();
  expect(screen.getByRole('header', { name: 'Khách mới' })).toBeOnTheScreen();
  expect(screen.queryByLabelText('Tìm khách hàng')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Chọn từ danh bạ'));
  await waitFor(() =>
    expect(screen.getByLabelText('Tên khách hàng')).toHaveProp(
      'value',
      'Chị Hạnh',
    ),
  );
  expect(screen.getByLabelText('Số điện thoại (không bắt buộc)')).toHaveProp(
    'value',
    '0909876543',
  );
  expect(Contact.presentPicker).toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Tạo khách hàng'));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Chị Hạnh', phone: '0909876543' }),
    ),
  );
  expect(onSelect).not.toHaveBeenCalled();
});

test('cancelling the system picker preserves manually entered fields', async () => {
  (Contact.presentPicker as jest.Mock).mockResolvedValueOnce(null);
  await renderWithProviders(
    <CustomerPicker onSelect={jest.fn()} onClose={jest.fn()} />,
  );
  await fireEvent.changeText(screen.getByLabelText('Tên khách hàng'), 'Lan');
  await fireEvent.press(screen.getByLabelText('Chọn từ danh bạ'));
  expect(screen.getByLabelText('Tên khách hàng')).toHaveProp('value', 'Lan');
});

test('picker failure keeps the manual form usable; a contact without a phone clears the old phone', async () => {
  (Contact.presentPicker as jest.Mock).mockRejectedValueOnce(
    new Error('unavailable'),
  );
  await renderWithProviders(
    <CustomerPicker onSelect={jest.fn()} onClose={jest.fn()} />,
  );
  await fireEvent.press(screen.getByLabelText('Chọn từ danh bạ'));
  expect(
    await screen.findByText(
      'Không mở được danh bạ. Thử lại hoặc nhập tên và số điện thoại.',
    ),
  ).toBeOnTheScreen();
  await fireEvent.changeText(
    screen.getByLabelText('Số điện thoại (không bắt buộc)'),
    '0901234567',
  );
  (Contact.presentPicker as jest.Mock).mockResolvedValueOnce({
    getFullName: async () => 'Hoa',
    getPhones: async () => [],
  });
  await fireEvent.press(screen.getByLabelText('Chọn từ danh bạ'));
  await waitFor(() =>
    expect(screen.getByLabelText('Tên khách hàng')).toHaveProp('value', 'Hoa'),
  );
  expect(screen.getByLabelText('Số điện thoại (không bắt buộc)')).toHaveProp(
    'value',
    '',
  );
});

test.each([
  ['  dang THI HOA  ', ''],
  ['Tên khác', '+84 912 345 678'],
])(
  'offers a normalized name or phone match before creating: %s / %s',
  async (name, phone) => {
    const existing = await createCustomer({
      id: newUuid(),
      name: 'Đặng Thị Hòa',
      phone: '0912345678',
    });
    const onSelect = jest.fn();
    const onCreate = jest.fn();
    const create = jest.spyOn(debtsApi, 'createCustomer');
    await renderWithProviders(
      <CustomerPicker
        mode="create"
        onSelect={onSelect}
        onCreate={onCreate}
        onClose={jest.fn()}
      />,
    );
    await fireEvent.changeText(screen.getByLabelText('Tên khách hàng'), name);
    await fireEvent.changeText(
      screen.getByLabelText('Số điện thoại (không bắt buộc)'),
      phone,
    );
    await fireEvent.press(screen.getByLabelText('Tạo khách hàng'));
    expect(await screen.findByText('Dùng khách này?')).toBeOnTheScreen();
    expect(create).not.toHaveBeenCalled();
    await fireEvent.press(
      screen.getByLabelText('Dùng khách này: Đặng Thị Hòa, 0đ'),
    );
    expect(onSelect).toHaveBeenCalledWith(existing);
    expect(onCreate).not.toHaveBeenCalled();
  },
);

test('checks beyond the first page and can explicitly create a separate profile', async () => {
  const existing = await createCustomer({ id: newUuid(), name: 'Cô Mai' });
  const list = jest
    .spyOn(debtsApi, 'listCustomers')
    .mockImplementation(async (params = {}) =>
      params.cursor
        ? { items: [existing], next_cursor: null }
        : { items: [], next_cursor: 'next' },
    );
  const onCreate = jest.fn();
  await renderWithProviders(
    <CustomerPicker
      mode="create"
      onSelect={jest.fn()}
      onCreate={onCreate}
      onClose={jest.fn()}
    />,
  );
  await fireEvent.changeText(screen.getByLabelText('Tên khách hàng'), 'co mai');
  await fireEvent.press(screen.getByLabelText('Tạo khách hàng'));
  await screen.findByText('Dùng khách này?');
  expect(list).toHaveBeenCalledWith({ cursor: 'next' });
  await fireEvent.press(screen.getByLabelText('Vẫn tạo khách mới'));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'co mai' }),
    ),
  );
});

test('a duplicate check failure blocks creation and can be retried', async () => {
  const list = jest.spyOn(debtsApi, 'listCustomers');
  const create = jest.spyOn(debtsApi, 'createCustomer');
  await renderWithProviders(
    <CustomerPicker mode="create" onSelect={jest.fn()} onClose={jest.fn()} />,
  );
  await fireEvent.changeText(screen.getByLabelText('Tên khách hàng'), 'Mai');
  list.mockRejectedValueOnce(new Error('offline'));
  await fireEvent.press(screen.getByLabelText('Tạo khách hàng'));
  expect(
    await screen.findByText('Không kiểm tra được khách trùng. Thử lại.'),
  ).toBeOnTheScreen();
  expect(create).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Tạo khách hàng'));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
});
