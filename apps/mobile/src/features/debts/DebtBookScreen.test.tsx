import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import * as debtsApi from '@/lib/api/debts';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';
import { seedCustomer } from '@/test/debts';

import { DebtBookScreen } from './DebtBookScreen';

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: jest.fn(() => true),
  },
}));

afterEach(() => jest.restoreAllMocks());

async function seed() {
  const lan = await seedCustomer({
    name: 'Chị Lan',
    phone: '0901234567',
    owes: 120000,
    ageDays: 10,
  });
  const mai = await seedCustomer({ name: 'Cô Mai', owes: 30000, ageDays: 2 });
  const hoa = await seedCustomer({ name: 'Anh Hòa' });
  return { lan, mai, hoa };
}
const rowNames = () =>
  screen
    .getAllByRole('button', { name: /^(Chị Lan|Cô Mai|Anh Hòa),/ })
    .map((row) => row.props.accessibilityLabel);

test('shows total outstanding and the overdue count above the list, largest debt first', async () => {
  await seed();
  await renderWithProviders(<DebtBookScreen />);
  expect(await screen.findByLabelText('Tổng nợ 150.000đ')).toBeOnTheScreen();
  expect(screen.getByLabelText('1 khách quá hạn, 120.000đ')).toBeOnTheScreen();
  expect(screen.getByRole('header', { name: 'Sổ nợ' })).toBeOnTheScreen();
  expect(await screen.findByText('Chị Lan')).toBeOnTheScreen();
  expect(rowNames()).toEqual([
    'Chị Lan, 120.000đ, quá hạn 10 ngày',
    'Cô Mai, 30.000đ',
    'Anh Hòa, 0đ',
  ]);
});

test('only an overdue customer gets the badge with its age in days', async () => {
  await seed();
  await renderWithProviders(<DebtBookScreen />);
  expect(await screen.findByText('Quá hạn 10 ngày')).toBeOnTheScreen();
  expect(screen.getAllByText(/^Quá hạn \d+ ngày$/)).toHaveLength(1);
});

test('exactly seven days is not overdue yet; eight is', async () => {
  await seedCustomer({ name: 'Bảy ngày', owes: 1000, ageDays: 7 });
  await seedCustomer({ name: 'Tám ngày', owes: 1000, ageDays: 8 });
  await renderWithProviders(<DebtBookScreen />);
  expect(await screen.findByText('Quá hạn 8 ngày')).toBeOnTheScreen();
  expect(screen.queryByText('Quá hạn 7 ngày')).toBeNull();
});

test('search sends the query and narrows the list by name or phone', async () => {
  await seed();
  const list = jest.spyOn(debtsApi, 'listCustomers');
  await renderWithProviders(<DebtBookScreen />);
  await screen.findByText('Cô Mai');
  await fireEvent.changeText(screen.getByLabelText('Tìm khách hàng'), 'mai');
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'mai' }),
    ),
  );
  await waitFor(() => expect(rowNames()).toEqual(['Cô Mai, 30.000đ']));
  await fireEvent.changeText(
    screen.getByLabelText('Tìm khách hàng'),
    '0901234567',
  );
  await waitFor(() =>
    expect(rowNames()).toEqual(['Chị Lan, 120.000đ, quá hạn 10 ngày']),
  );
});

test('the Quá hạn chip asks the server for overdue customers only and toggles off again', async () => {
  await seed();
  const list = jest.spyOn(debtsApi, 'listCustomers');
  await renderWithProviders(<DebtBookScreen />);
  await screen.findByText('Cô Mai');
  const chip = () => screen.getByRole('button', { name: 'Quá hạn' });
  expect(chip()).not.toBeSelected();
  await fireEvent.press(chip());
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ overdue: true }),
    ),
  );
  await waitFor(() =>
    expect(rowNames()).toEqual(['Chị Lan, 120.000đ, quá hạn 10 ngày']),
  );
  expect(chip()).toBeSelected();
  await fireEvent.press(chip());
  await waitFor(() => expect(rowNames()).toHaveLength(3));
  expect(list.mock.calls.at(-1)![0]).not.toHaveProperty('overdue');
});

test('a row opens the customer screen', async () => {
  const { mai } = await seed();
  await renderWithProviders(<DebtBookScreen />);
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Cô Mai, 30.000đ' }),
  );
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/customer/[id]',
    params: { id: mai.id },
  });
});

test('the back circle goes back, or home when there is nothing to go back to', async () => {
  await renderWithProviders(<DebtBookScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Quay lại' }));
  expect(router.back).toHaveBeenCalled();
  (router.canGoBack as jest.Mock).mockReturnValueOnce(false);
  await fireEvent.press(screen.getByRole('button', { name: 'Quay lại' }));
  expect(router.replace).toHaveBeenCalledWith('/');
});

test('empty book and empty search say different things', async () => {
  await renderWithProviders(<DebtBookScreen />);
  expect(await screen.findByText('Chưa có khách hàng nào')).toBeOnTheScreen();
  expect(await screen.findByLabelText('Tổng nợ 0đ')).toBeOnTheScreen();
  await fireEvent.changeText(screen.getByLabelText('Tìm khách hàng'), 'zzz');
  expect(
    await screen.findByText('Không tìm thấy khách hàng'),
  ).toBeOnTheScreen();
});

test('scrolling to the end loads the next page by cursor', async () => {
  await seed();
  const page = await debtsApi.listCustomers();
  const list = jest
    .spyOn(debtsApi, 'listCustomers')
    .mockImplementation(async ({ cursor } = {}) => ({
      items: cursor ? page.items!.slice(1) : page.items!.slice(0, 1),
      next_cursor: cursor ? null : 'next',
    }));
  await renderWithProviders(<DebtBookScreen />);
  await screen.findByText('Chị Lan');
  expect(screen.queryByText('Cô Mai')).toBeNull();
  await act(async () => screen.getByTestId('debt-list').props.onEndReached());
  expect(await screen.findByText('Cô Mai')).toBeOnTheScreen();
  expect(list).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: 'next' }),
  );
  await act(async () => screen.getByTestId('debt-list').props.onEndReached());
  expect(list).toHaveBeenCalledTimes(2);
});

test('a failed list load can be retried', async () => {
  await seed();
  jest
    .spyOn(debtsApi, 'listCustomers')
    .mockRejectedValueOnce(new Error('offline'));
  await renderWithProviders(<DebtBookScreen />);
  expect(await screen.findByText('Không tải được sổ nợ')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  expect(await screen.findByText('Chị Lan')).toBeOnTheScreen();
});

test('a failed summary load can be retried without hiding the list', async () => {
  await seed();
  jest
    .spyOn(debtsApi, 'getDebtSummary')
    .mockRejectedValueOnce(new Error('offline'));
  await renderWithProviders(<DebtBookScreen />);
  expect(await screen.findByText('Chị Lan')).toBeOnTheScreen();
  expect(await screen.findByText('Không tải được tổng nợ')).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Thử lại tổng nợ' }),
  );
  expect(await screen.findByLabelText('Tổng nợ 150.000đ')).toBeOnTheScreen();
});

test('English labels follow the language', async () => {
  useSettingsStore.setState({ language: 'en' });
  await seed();
  await renderWithProviders(<DebtBookScreen />);
  expect(await screen.findByLabelText('Total owed 150.000đ')).toBeOnTheScreen();
  expect(screen.getByRole('header', { name: 'Debt book' })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Overdue' })).toBeOnTheScreen();
  expect(await screen.findByText('Overdue 10 days')).toBeOnTheScreen();
  expect(screen.getByLabelText('1 overdue, 120.000đ')).toBeOnTheScreen();
});

test('a negative balance is shown as money the store holds', async () => {
  const lan = await seedCustomer({ name: 'Chị Lan', owes: 10000 });
  await debtsApi.createRepayment(
    lan.id,
    { amount: 25000, method: 'cash' },
    'key-over',
  );
  await renderWithProviders(<DebtBookScreen />);
  expect(
    await screen.findByRole('button', { name: 'Chị Lan, -15.000đ' }),
  ).toBeOnTheScreen();
  expect(screen.getByLabelText('Tổng nợ 0đ')).toBeOnTheScreen();
});

test('the add circle creates a profile without a sale and opens its customer screen', async () => {
  await renderWithProviders(<DebtBookScreen />);
  await fireEvent.press(screen.getByLabelText('Thêm khách hàng'));
  expect(screen.getByRole('header', { name: 'Khách mới' })).toBeOnTheScreen();
  await fireEvent.changeText(screen.getByLabelText('Tên khách hàng'), 'Cô Hoa');
  await fireEvent.changeText(
    screen.getByLabelText('Số điện thoại (không bắt buộc)'),
    '0912345678',
  );
  await fireEvent.press(screen.getByLabelText('Tạo khách hàng'));
  await waitFor(() =>
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/customer/[id]',
      params: { id: expect.any(String) },
    }),
  );
  const customer = (await debtsApi.listCustomers({ query: 'Hoa' })).items![0]!;
  expect(router.push).toHaveBeenLastCalledWith({
    pathname: '/customer/[id]',
    params: { id: customer.id },
  });
  expect(screen.queryByLabelText('Tên khách hàng')).toBeNull();
});
