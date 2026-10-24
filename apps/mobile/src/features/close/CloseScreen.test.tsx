import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';

import { resetApiClient } from '@/lib/api';
import * as ledger from '@/lib/api/ledger';
import { businessDate } from '@/lib/date';
import { formatVnd } from '@/lib/format';
import { resetMockDb } from '@/test/mock';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';

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

afterEach(() => jest.restoreAllMocks());

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
