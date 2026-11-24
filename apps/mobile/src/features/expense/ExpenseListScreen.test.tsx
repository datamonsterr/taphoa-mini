import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import { resetApiClient } from '@/lib/api';
import * as ledger from '@/lib/api/ledger';
import { formatVnd } from '@/lib/format';
import { resetMockDb } from '@/test/mock';
import { getMockDb } from '@/test/mock/db';
import { createTestQueryClient, renderWithProviders } from '@/test/render';
import { setTestMembership, testSession } from '@/test/session';

import { ExpenseListScreen } from './ExpenseListScreen';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

beforeEach(() => {
  resetMockDb();
  resetApiClient();
  jest.clearAllMocks();
});
afterEach(() => jest.restoreAllMocks());

const newest = () =>
  [...getMockDb().expenses].sort((a, b) =>
    b.spent_at.localeCompare(a.spent_at),
  )[0]!;
const labelOf = (e: { category: string; amount: number }) =>
  new RegExp(`, ${formatVnd(e.amount).replace('.', '\\.')}`);
const openNewest = async () => {
  const expense = newest();
  await renderWithProviders(<ExpenseListScreen />);
  const rows = await screen.findAllByRole('button', {
    name: labelOf(expense),
  });
  await fireEvent.press(rows[0]!);
  return expense;
};

test('lists expenses and goes back to the reports', async () => {
  await renderWithProviders(<ExpenseListScreen />);
  expect(
    await screen.findByRole('header', { name: 'Khoản chi gần đây' }),
  ).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Quay lại Báo cáo' }),
  );
  expect(router.replace).toHaveBeenCalledWith('/dashboard');
});

test('lead edits amount, category and note of an expense', async () => {
  const expense = await openNewest();
  expect(
    await screen.findByRole('header', { name: 'Sửa khoản chi' }),
  ).toBeOnTheScreen();
  await fireEvent.changeText(screen.getByLabelText('Số tiền chi'), '123456');
  await fireEvent.press(screen.getByRole('radio', { name: 'Nước' }));
  await fireEvent.changeText(
    screen.getByLabelText('Ghi chú'),
    'Tiền nước tháng 11',
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await waitFor(() =>
    expect(screen.queryByRole('header', { name: 'Sửa khoản chi' })).toBeNull(),
  );
  const saved = getMockDb().expenses.find((e) => e.id === expense.id)!;
  expect(saved).toMatchObject({
    amount: 123456,
    category: 'nuoc',
    note: 'Tiền nước tháng 11',
  });
  expect(
    await screen.findByRole('button', { name: `Nước, ${formatVnd(123456)}` }),
  ).toBeOnTheScreen();
});

test('an empty or zero amount cannot be saved', async () => {
  await openNewest();
  await fireEvent.changeText(screen.getByLabelText('Số tiền chi'), '0');
  expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toBeDisabled();
});

test('lead deletes an expense only after confirming', async () => {
  const expense = await openNewest();
  const before = getMockDb().expenses.length;
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Xóa khoản chi' }),
  );
  expect(screen.getByText('Xóa khoản chi này?')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Giữ lại' }));
  expect(getMockDb().expenses).toHaveLength(before);
  await fireEvent.press(screen.getByRole('button', { name: 'Xóa khoản chi' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Xóa' }));
  await waitFor(() =>
    expect(getMockDb().expenses.some((e) => e.id === expense.id)).toBe(false),
  );
  await waitFor(() =>
    expect(screen.queryByRole('header', { name: 'Sửa khoản chi' })).toBeNull(),
  );
});

test('offline: the edit is refused in plain words and nothing is queued', async () => {
  jest
    .spyOn(ledger, 'updateExpense')
    .mockRejectedValueOnce(new TypeError('Network request failed'));
  await openNewest();
  await fireEvent.changeText(screen.getByLabelText('Số tiền chi'), '777');
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  expect(
    await screen.findByText('Không lưu được. Kiểm tra mạng và thử lại.'),
  ).toBeOnTheScreen();
  expect(
    screen.getByRole('header', { name: 'Sửa khoản chi' }),
  ).toBeOnTheScreen();
});

test('a delete that fails keeps the expense and says so', async () => {
  jest
    .spyOn(ledger, 'deleteExpense')
    .mockRejectedValueOnce(new TypeError('Network request failed'));
  await openNewest();
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Xóa khoản chi' }),
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Xóa' }));
  expect(
    await screen.findByText('Không xóa được. Kiểm tra mạng và thử lại.'),
  ).toBeOnTheScreen();
});

test('a seller edits only their own expense and cannot delete', async () => {
  const session = testSession();
  const sellerId = session.member.id;
  setTestMembership({
    ...session,
    member: { ...session.member, role: 'seller' },
  });
  const [own, other] = [...getMockDb().expenses].sort((a, b) =>
    b.spent_at.localeCompare(a.spent_at),
  );
  own!.member_id = sellerId;
  other!.member_id = 'someone-else';
  other!.amount = 987654;
  await renderWithProviders(<ExpenseListScreen />);
  const rows = await screen.findAllByRole('button', { name: labelOf(own!) });
  expect(screen.queryByRole('button', { name: labelOf(other!) })).toBeNull();
  await fireEvent.press(rows[0]!);
  expect(
    await screen.findByRole('header', { name: 'Sửa khoản chi' }),
  ).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Xóa khoản chi' })).toBeNull();
});

test('saving and deleting refresh the expense list and the reports', async () => {
  const client = createTestQueryClient();
  const spy = jest.spyOn(client, 'invalidateQueries');
  const expense = newest();
  await renderWithProviders(<ExpenseListScreen />, client);
  const rows = await screen.findAllByRole('button', { name: labelOf(expense) });
  await fireEvent.press(rows[0]!);
  await fireEvent.changeText(screen.getByLabelText('Số tiền chi'), '555');
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu thay đổi' }));
  await waitFor(() => expect(spy).toHaveBeenCalled());
  const touched = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  expect(touched.some((k) => k.includes('expenses'))).toBe(true);
  expect(touched.some((k) => k.includes('reports'))).toBe(true);
});
