import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { onlineManager } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';

import { resetApiClient } from '@/lib/api';
import * as debtsApi from '@/lib/api/debts';
import * as ledger from '@/lib/api/ledger';
import { businessDate } from '@/lib/date';
import { formatVnd } from '@/lib/format';
import { resetMockDb } from '@/test/mock';
import { useSettingsStore } from '@/stores/settings';
import { seedCustomer } from '@/test/debts';
import { renderWithProviders } from '@/test/render';
import { newUuid } from '@/lib/uuid';

import { CloseScreen } from './CloseScreen';

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: jest.fn(() => true),
  },
}));

beforeEach(() => {
  resetMockDb();
  resetApiClient();
  jest.clearAllMocks();
});

afterEach(() => {
  onlineManager.setOnline(true);
  jest.restoreAllMocks();
});

const date = () => businessDate();
const press = (name: string) =>
  fireEvent.press(screen.getByRole('button', { name }));
const typeAmount = async (amount: number) => {
  for (const digit of String(amount)) await press(digit);
};
const expectedCash = async () => (await ledger.getTodayReport()).expected_cash;
const save = () => screen.getByRole('button', { name: 'Chốt sổ hôm nay' });

test('shows a skeleton while loading', async () => {
  let release: () => void = () => {};
  const real = ledger.getTodayReport;
  jest.spyOn(ledger, 'getTodayReport').mockImplementationOnce(
    (day) =>
      new Promise((resolve) => {
        release = () => resolve(real(day));
      }),
  );
  await renderWithProviders(<CloseScreen />);
  expect(screen.getByTestId('close-skeleton')).toBeOnTheScreen();
  release();
  await screen.findByLabelText(/^Tiền mặt dự kiến/);
  expect(screen.queryByTestId('close-skeleton')).toBeNull();
});

test('shows the title, the date and the expected cash', async () => {
  await renderWithProviders(<CloseScreen />);
  const expected = await expectedCash();
  expect(
    await screen.findByLabelText(`Tiền mặt dự kiến ${formatVnd(expected)}`),
  ).toBeOnTheScreen();
  expect(screen.getByRole('header', { name: 'Chốt sổ' })).toBeOnTheScreen();
  expect(screen.getByText(/^\d{2}\/\d{2}$/)).toBeOnTheScreen();
  expect(screen.getByLabelText('Tiền đếm được')).toHaveTextContent('0đ');
});

test('counted cash short of expected shows a red difference', async () => {
  await renderWithProviders(<CloseScreen />);
  const expected = await expectedCash();
  await screen.findByLabelText(/^Tiền mặt dự kiến/);
  expect(
    screen.getByLabelText(`Thiếu ${formatVnd(expected)}`),
  ).toBeOnTheScreen();
  await typeAmount(expected - 10000);
  expect(screen.getByLabelText('Thiếu 10.000đ')).toBeOnTheScreen();
});

test('counted cash equal to expected matches', async () => {
  await renderWithProviders(<CloseScreen />);
  const expected = await expectedCash();
  await screen.findByLabelText(/^Tiền mặt dự kiến/);
  await typeAmount(expected);
  expect(screen.getByLabelText('Khớp')).toBeOnTheScreen();
  expect(screen.getByLabelText('Tiền đếm được')).toHaveTextContent(
    formatVnd(expected),
  );
});

test('extra cash shows an amber difference; delete and 000 work', async () => {
  await renderWithProviders(<CloseScreen />);
  const expected = await expectedCash();
  await screen.findByLabelText(/^Tiền mặt dự kiến/);
  await press('5');
  await press('000');
  expect(screen.getByLabelText('Tiền đếm được')).toHaveTextContent('5.000đ');
  await press('Xóa');
  await press('Xóa');
  await press('Xóa');
  await press('Xóa');
  await typeAmount(expected + 5000);
  expect(screen.getByLabelText(`Dư ${formatVnd(5000)}`)).toBeOnTheScreen();
});

test('check stores the close, buzzes and dismisses', async () => {
  await renderWithProviders(<CloseScreen />);
  const expected = await expectedCash();
  await screen.findByLabelText(/^Tiền mặt dự kiến/);
  await typeAmount(expected);
  await fireEvent.press(save());
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
  expect(await ledger.getDayClose(date())).toMatchObject({
    counted_cash: expected,
    expected_cash: expected,
    difference: 0,
  });
});

test('save is disabled until a digit is typed; an explicit 0 counts', async () => {
  const create = jest.spyOn(ledger, 'createDayClose');
  await renderWithProviders(<CloseScreen />);
  await screen.findByLabelText(/^Tiền mặt dự kiến/);
  expect(save()).toBeDisabled();
  await fireEvent.press(save());
  expect(create).not.toHaveBeenCalled();
  await press('0');
  expect(save()).toBeEnabled();
  await press('Xóa');
  expect(save()).toBeDisabled();
});

test('the close circle dismisses without closing the day', async () => {
  await renderWithProviders(<CloseScreen />);
  await screen.findByLabelText(/^Tiền mặt dự kiến/);
  await fireEvent.press(screen.getByTestId('close-close'));
  expect(router.back).toHaveBeenCalled();
  await expect(ledger.getDayClose(date())).rejects.toMatchObject({
    status: 404,
  });
});

test('a failed save keeps the sheet open and says so', async () => {
  jest.spyOn(ledger, 'createDayClose').mockRejectedValueOnce(new Error('x'));
  await renderWithProviders(<CloseScreen />);
  await screen.findByLabelText(/^Tiền mặt dự kiến/);
  await press('5');
  await fireEvent.press(save());
  expect(
    await screen.findByText('Không chốt được sổ. Thử lại.'),
  ).toBeOnTheScreen();
  expect(router.back).not.toHaveBeenCalled();
  await fireEvent.press(save());
  await waitFor(() => expect(router.back).toHaveBeenCalled());
});

test('an already closed day is shown read-only', async () => {
  const expected = await expectedCash();
  await ledger.createDayClose(date(), { counted_cash: expected + 20000 });
  await renderWithProviders(<CloseScreen />);
  expect(await screen.findByText('Đã chốt sổ')).toBeOnTheScreen();
  expect(screen.getByLabelText('Tiền đếm được')).toHaveTextContent(
    formatVnd(expected + 20000),
  );
  expect(screen.getByLabelText('Dư 20.000đ')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: '1' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Chốt sổ hôm nay' })).toBeNull();
  await fireEvent.press(screen.getByTestId('close-close'));
  expect(router.back).toHaveBeenCalled();
});

test('a failed load shows an error that retries', async () => {
  jest.spyOn(ledger, 'getTodayReport').mockRejectedValueOnce(new Error('x'));
  await renderWithProviders(<CloseScreen />);
  expect(await screen.findByText('Không tải được số liệu')).toBeOnTheScreen();
  await press('Thử lại');
  expect(await screen.findByLabelText(/^Tiền mặt dự kiến/)).toBeOnTheScreen();
});

test('English: the difference pill and keypad delete follow the language', async () => {
  useSettingsStore.setState({ language: 'en' });
  await renderWithProviders(<CloseScreen />);
  await screen.findByLabelText(/^Expected cash/);
  expect(screen.getByText(/^Short /)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeOnTheScreen();
});

describe('debts', () => {
  async function lanPaysSomething() {
    const lan = await seedCustomer({ name: 'Chị Lan', owes: 30000 });
    await debtsApi.createRepayment(
      lan.id,
      { amount: 10000, method: 'cash' },
      newUuid(),
    );
    await debtsApi.createRepayment(
      lan.id,
      { amount: 4000, method: 'transfer' },
      newUuid(),
    );
  }

  test('cash collected on debts counts toward the expected cash; credit sales do not', async () => {
    const before = await expectedCash();
    await lanPaysSomething();
    expect(await expectedCash()).toBe(before + 10000);
    await renderWithProviders(<CloseScreen />);
    expect(
      await screen.findByLabelText(
        `Tiền mặt dự kiến ${formatVnd(before + 10000)}`,
      ),
    ).toBeOnTheScreen();
  });

  test('a closed day lists cash repayments and credit sales as separate lines', async () => {
    await lanPaysSomething();
    await ledger.createDayClose(date(), { counted_cash: await expectedCash() });
    await renderWithProviders(<CloseScreen />);
    expect(await screen.findByText('Đã chốt sổ')).toBeOnTheScreen();
    expect(screen.getByLabelText('Thu nợ tiền mặt 10.000đ')).toBeOnTheScreen();
    expect(screen.getByLabelText('Bán ghi nợ 30.000đ')).toBeOnTheScreen();
  });

  test('an open day lists cash repayments and credit sales before closing', async () => {
    await lanPaysSomething();
    await renderWithProviders(<CloseScreen />);
    expect(
      await screen.findByLabelText('Thu nợ tiền mặt 10.000đ'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Bán ghi nợ 30.000đ')).toBeOnTheScreen();
    expect(screen.queryByText('Đã chốt sổ')).toBeNull();
    expect(screen.getByRole('button', { name: '1' })).toBeOnTheScreen();
  });

  test('an open day without debts shows neither line', async () => {
    await renderWithProviders(<CloseScreen />);
    await screen.findByLabelText(/^Tiền mặt dự kiến/);
    expect(screen.queryByLabelText(/^Thu nợ tiền mặt/)).toBeNull();
    expect(screen.queryByLabelText(/^Bán ghi nợ/)).toBeNull();
  });

  test('an open day shows only the line that has an amount', async () => {
    const old = await seedCustomer({ name: 'Chú Ba', owes: 20000, ageDays: 3 });
    await debtsApi.createRepayment(
      old.id,
      { amount: 10000, method: 'cash' },
      newUuid(),
    );
    await renderWithProviders(<CloseScreen />);
    expect(
      await screen.findByLabelText('Thu nợ tiền mặt 10.000đ'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Bán ghi nợ/)).toBeNull();
  });

  test('a closed day without debts shows neither line', async () => {
    await ledger.createDayClose(date(), { counted_cash: await expectedCash() });
    await renderWithProviders(<CloseScreen />);
    expect(await screen.findByText('Đã chốt sổ')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Thu nợ tiền mặt/)).toBeNull();
    expect(screen.queryByLabelText(/^Bán ghi nợ/)).toBeNull();
  });

  test('English labels', async () => {
    useSettingsStore.setState({ language: 'en' });
    await lanPaysSomething();
    await ledger.createDayClose(date(), { counted_cash: await expectedCash() });
    await renderWithProviders(<CloseScreen />);
    expect(
      await screen.findByLabelText('Cash debt collected 10.000đ'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Credit sales 30.000đ')).toBeOnTheScreen();
  });
});

const OFFLINE =
  'Không có mạng nên chưa chốt được sổ. Tiền đếm được vẫn còn, thử lại khi có mạng.';

test('closing the day offline says so at once, sends nothing and keeps the count (#205)', async () => {
  const create = jest.spyOn(ledger, 'createDayClose');
  await renderWithProviders(<CloseScreen />);
  await screen.findByLabelText(/^Tiền mặt dự kiến/);
  await typeAmount(30000);
  await act(async () => onlineManager.setOnline(false));
  await fireEvent.press(save());
  expect(await screen.findByText(OFFLINE)).toBeOnTheScreen();
  expect(create).not.toHaveBeenCalled();
  expect(save()).toBeEnabled();
  expect(router.back).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Tiền đếm được')).toHaveTextContent(
    formatVnd(30000),
  );
  // the close is not left waiting: reconnecting sends nothing by itself
  await act(async () => onlineManager.setOnline(true));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(create).not.toHaveBeenCalled();
  await expect(ledger.getDayClose(date())).rejects.toMatchObject({
    status: 404,
  });
  // and the seller can close once the network is back
  await fireEvent.press(save());
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(create).toHaveBeenCalledTimes(1);
});

test('a close that fails because the connection dropped says there is no network', async () => {
  jest.spyOn(ledger, 'createDayClose').mockImplementationOnce(async () => {
    onlineManager.setOnline(false);
    throw new TypeError('Network request failed');
  });
  await renderWithProviders(<CloseScreen />);
  await screen.findByLabelText(/^Tiền mặt dự kiến/);
  await press('5');
  await fireEvent.press(save());
  expect(await screen.findByText(OFFLINE)).toBeOnTheScreen();
});
