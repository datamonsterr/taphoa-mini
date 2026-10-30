import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import { onlineManager } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Share } from 'react-native';

import * as debtsApi from '@/lib/api/debts';
import { getStore } from '@/lib/api/store';
import { businessDate } from '@/lib/date';
import { useSettingsStore } from '@/stores/settings';
import { holdNext } from '@/test/hold';
import { voidSale } from '@/test/mock/ledger';
import { renderWithProviders } from '@/test/render';
import { setTestMembership, testSession } from '@/test/session';
import { creditSale, seedCustomer } from '@/test/debts';
import { newUuid } from '@/lib/uuid';

import { dayMonth } from '../close/difference';
import { CustomerScreen } from './CustomerScreen';
import { buildReminderText } from './reminder';

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: jest.fn(() => true),
  },
}));

afterEach(() => {
  onlineManager.setOnline(true);
  jest.restoreAllMocks();
});

const press = (name: string) =>
  fireEvent.press(screen.getByRole('button', { name }));
const type = (label: string, text: string) =>
  fireEvent.changeText(screen.getByLabelText(label), text);
const sheetClosed = (title: string) =>
  waitFor(() =>
    expect(screen.queryByRole('header', { name: title })).toBeNull(),
  );
const ledgerRows = () =>
  screen
    .getAllByTestId('ledger-row')
    .map((row) => row.props.accessibilityLabel);
const today = () => dayMonth(businessDate());

function actAsSeller() {
  const session = testSession();
  setTestMembership({
    ...session,
    member: { ...session.member, role: 'seller' },
  });
}

/** Lan owes 105.000đ: two credit sales (one voided), a cash repayment and a +5.000đ adjustment. */
async function seedLan() {
  const lan = await seedCustomer({
    name: 'Chị Lan',
    phone: '0901234567',
    note: 'Hay quên',
    credit_limit: 500000,
    owes: 120000,
    ageDays: 10,
  });
  const second = await creditSale(lan.id, 30000);
  voidSale(second.id, { reason: 'Nhầm đơn' });
  await debtsApi.createRepayment(
    lan.id,
    { amount: 20000, method: 'cash' },
    newUuid(),
  );
  await debtsApi.createDebtAdjustment(
    lan.id,
    { amount: 5000, reason: 'Nhập sổ cũ' },
    newUuid(),
  );
  return lan;
}

async function renderLan() {
  const lan = await seedLan();
  await renderWithProviders(<CustomerScreen id={lan.id} />);
  await screen.findByLabelText('Đang nợ 105.000đ');
  return lan;
}

describe('profile and ledger', () => {
  test('shows name, phone, note, credit limit, balance and the overdue age', async () => {
    await renderLan();
    expect(screen.getByRole('header', { name: 'Chị Lan' })).toBeOnTheScreen();
    // Board 21: the phone sits under the name in the header, not in the balance card.
    expect(screen.getByText('0901234567')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Điện thoại/)).toBeNull();
    expect(screen.getByLabelText('Ghi chú Hay quên')).toBeOnTheScreen();
    expect(screen.getByLabelText('Hạn mức nợ 500.000đ')).toBeOnTheScreen();
    expect(screen.getByText('Quá hạn 10 ngày')).toBeOnTheScreen();
    expect(screen.queryByText('Vượt hạn mức ghi nợ')).toBeNull();
  });

  test('lists the ledger newest first with a Vietnamese kind, signed amount and balance after', async () => {
    await renderLan();
    const d = today();
    const old = dayMonth(businessDate(Date.now() - 10 * 24 * 60 * 60 * 1000));
    await waitFor(() => expect(ledgerRows()).toHaveLength(5));
    expect(ledgerRows()).toEqual([
      `Điều chỉnh · Nhập sổ cũ, +5.000đ, ${d}, Số dư 105.000đ`,
      `Trả nợ · Tiền mặt, -20.000đ, ${d}, Số dư 100.000đ`,
      `Huỷ đơn, -30.000đ, ${d}, Số dư 120.000đ`,
      `Ghi nợ, +30.000đ, ${d}, Số dư 150.000đ`,
      `Ghi nợ, +120.000đ, ${old}, Số dư 120.000đ`,
    ]);
    const first = screen.getAllByTestId('ledger-row')[0]!;
    expect(within(first).getByText('+5.000đ')).toBeOnTheScreen();
    // Board: date and time under the title; the running balance is spoken only.
    expect(
      within(first).getByText(/^\d{2}\/\d{2} · \d{2}:\d{2}$/),
    ).toBeOnTheScreen();
    expect(within(first).queryByText('Số dư 105.000đ')).toBeNull();
  });

  test('a customer who owes more than the limit gets a warning, not a block', async () => {
    const lan = await seedCustomer({
      name: 'Chị Lan',
      credit_limit: 100000,
      owes: 120000,
    });
    await renderWithProviders(<CustomerScreen id={lan.id} />);
    expect(await screen.findByText('Vượt hạn mức ghi nợ')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Thu nợ' })).toBeEnabled();
  });

  test('balances at or below zero read as settled or customer credit', async () => {
    const settled = await seedCustomer({ name: 'Cô Mai' });
    await renderWithProviders(<CustomerScreen id={settled.id} />);
    expect(await screen.findByLabelText('Hết nợ 0đ')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Hạn mức nợ/)).toBeNull();
    expect(await screen.findByText('Chưa có giao dịch')).toBeOnTheScreen();
  });

  test('a negative balance is customer credit', async () => {
    const lan = await seedCustomer({ name: 'Chị Lan', owes: 10000 });
    await debtsApi.createRepayment(
      lan.id,
      { amount: 25000, method: 'cash' },
      newUuid(),
    );
    await renderWithProviders(<CustomerScreen id={lan.id} />);
    expect(
      await screen.findByLabelText('Khách trả dư 15.000đ'),
    ).toBeOnTheScreen();
  });

  test('scrolling to the end loads older entries by cursor', async () => {
    const lan = await seedLan();
    const all = (await debtsApi.listDebtEntries(lan.id)).items!;
    const list = jest
      .spyOn(debtsApi, 'listDebtEntries')
      .mockImplementation(async (_id, { cursor } = {}) => ({
        items: cursor ? all.slice(1) : all.slice(0, 1),
        next_cursor: cursor ? null : 'next',
      }));
    await renderWithProviders(<CustomerScreen id={lan.id} />);
    await waitFor(() => expect(ledgerRows()).toHaveLength(1));
    await act(async () =>
      screen.getByTestId('ledger-list').props.onEndReached(),
    );
    await waitFor(() => expect(ledgerRows()).toHaveLength(5));
    expect(list).toHaveBeenLastCalledWith(lan.id, { cursor: 'next' });
  });

  test('a failed ledger load can be retried', async () => {
    const lan = await seedLan();
    jest
      .spyOn(debtsApi, 'listDebtEntries')
      .mockRejectedValueOnce(new Error('offline'));
    await renderWithProviders(<CustomerScreen id={lan.id} />);
    expect(await screen.findByText('Không tải được lịch sử')).toBeOnTheScreen();
    await press('Thử lại');
    await waitFor(() => expect(ledgerRows()).toHaveLength(5));
  });
});

describe('loading and failure', () => {
  test('waits for the customer before showing anything', async () => {
    const lan = await seedCustomer({ name: 'Chị Lan' });
    const release = holdNext(debtsApi, 'getCustomer');
    await renderWithProviders(<CustomerScreen id={lan.id} />);
    expect(screen.getByLabelText('Đang tải khách hàng')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Thu nợ' })).toBeNull();
    await act(async () => release());
    expect(
      await screen.findByRole('button', { name: 'Thu nợ' }),
    ).toBeOnTheScreen();
  });

  test('an unknown customer is not found', async () => {
    await renderWithProviders(<CustomerScreen id={newUuid()} />);
    expect(
      await screen.findByText('Không tìm thấy khách hàng'),
    ).toBeOnTheScreen();
  });

  test('a network failure shows an error with retry', async () => {
    const lan = await seedCustomer({ name: 'Chị Lan' });
    jest
      .spyOn(debtsApi, 'getCustomer')
      .mockRejectedValueOnce(new TypeError('offline'));
    await renderWithProviders(<CustomerScreen id={lan.id} />);
    expect(
      await screen.findByText('Không tải được khách hàng'),
    ).toBeOnTheScreen();
    await press('Thử lại');
    expect(
      await screen.findByRole('header', { name: 'Chị Lan' }),
    ).toBeOnTheScreen();
  });

  test('the back circle goes back, or home when nothing is behind', async () => {
    await renderLan();
    await press('Quay lại');
    expect(router.back).toHaveBeenCalled();
    (router.canGoBack as jest.Mock).mockReturnValueOnce(false);
    await press('Quay lại');
    expect(router.replace).toHaveBeenCalledWith('/');
  });
});

describe('Thu nợ', () => {
  test('opens with the whole balance in cash, then records a part payment by transfer', async () => {
    const lan = await renderLan();
    const create = jest.spyOn(debtsApi, 'createRepayment');
    await press('Thu nợ');
    expect(screen.getByRole('header', { name: 'Thu nợ' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Số tiền thu')).toHaveDisplayValue('105000');
    expect(screen.getByRole('radio', { name: 'Tiền mặt' })).toBeChecked();
    expect(screen.queryByText(/lớn hơn số đang nợ/)).toBeNull();

    await type('Số tiền thu', '50000');
    await fireEvent.press(screen.getByRole('radio', { name: 'Chuyển khoản' }));
    expect(screen.getByRole('radio', { name: 'Chuyển khoản' })).toBeChecked();
    await press('Xác nhận thu nợ');

    await sheetClosed('Thu nợ');
    expect(create).toHaveBeenCalledWith(
      lan.id,
      { amount: 50000, method: 'transfer' },
      expect.any(String),
    );
    expect(await screen.findByLabelText('Đang nợ 55.000đ')).toBeOnTheScreen();
    await waitFor(() => expect(ledgerRows()).toHaveLength(6));
    expect(ledgerRows()[0]).toBe(
      `Trả nợ · Chuyển khoản, -50.000đ, ${today()}, Số dư 55.000đ`,
    );
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
  });

  test('more than the balance warns but is still allowed', async () => {
    await renderLan();
    await press('Thu nợ');
    await type('Số tiền thu', '105000');
    expect(screen.queryByText(/lớn hơn số đang nợ/)).toBeNull();
    await type('Số tiền thu', '200000');
    expect(
      screen.getByText(
        'Số tiền lớn hơn số đang nợ. Phần dư được ghi là khách trả dư.',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Xác nhận thu nợ' }),
    ).toBeEnabled();
    await press('Xác nhận thu nợ');
    expect(
      await screen.findByLabelText('Khách trả dư 95.000đ'),
    ).toBeOnTheScreen();
  });

  test('confirm needs an amount above zero and ignores non-digits', async () => {
    await renderLan();
    await press('Thu nợ');
    await type('Số tiền thu', '');
    expect(
      screen.getByRole('button', { name: 'Xác nhận thu nợ' }),
    ).toBeDisabled();
    await type('Số tiền thu', '0');
    expect(
      screen.getByRole('button', { name: 'Xác nhận thu nợ' }),
    ).toBeDisabled();
    await type('Số tiền thu', '12.5k');
    expect(screen.getByLabelText('Số tiền thu')).toHaveDisplayValue('125');
    expect(
      screen.getByRole('button', { name: 'Xác nhận thu nợ' }),
    ).toBeEnabled();
  });

  test('a customer who owes nothing starts with an empty amount', async () => {
    const mai = await seedCustomer({ name: 'Cô Mai' });
    await renderWithProviders(<CustomerScreen id={mai.id} />);
    await screen.findByLabelText('Hết nợ 0đ');
    await press('Thu nợ');
    expect(screen.getByLabelText('Số tiền thu')).toHaveDisplayValue('');
    expect(
      screen.getByRole('button', { name: 'Xác nhận thu nợ' }),
    ).toBeDisabled();
  });

  test('collecting offline says so at once, keeps the amount and never drops the payment (#205)', async () => {
    const lan = await renderLan();
    const create = jest.spyOn(debtsApi, 'createRepayment');
    await press('Thu nợ');
    await type('Số tiền thu', '1000');
    await act(async () => onlineManager.setOnline(false));
    await press('Xác nhận thu nợ');
    expect(
      await screen.findByText(
        'Không có mạng nên chưa ghi được khoản thu. Số tiền vẫn còn, thử lại khi có mạng.',
      ),
    ).toBeOnTheScreen();
    expect(create).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Xác nhận thu nợ' }),
    ).toBeEnabled();
    expect(screen.getByLabelText('Số tiền thu')).toHaveDisplayValue('1000');
    expect(screen.getByRole('header', { name: 'Thu nợ' })).toBeOnTheScreen();
    // back online, the same sheet records it once
    await act(async () => onlineManager.setOnline(true));
    await press('Xác nhận thu nợ');
    await sheetClosed('Thu nợ');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      lan.id,
      { amount: 1000, method: 'cash' },
      expect.any(String),
    );
  });

  test('a payment that fails because the connection dropped says there is no network', async () => {
    await renderLan();
    jest.spyOn(debtsApi, 'createRepayment').mockImplementationOnce(async () => {
      onlineManager.setOnline(false);
      throw new TypeError('Network request failed');
    });
    await press('Thu nợ');
    await press('Xác nhận thu nợ');
    expect(
      await screen.findByText(/^Không có mạng nên chưa ghi được khoản thu/),
    ).toBeOnTheScreen();
  });

  test('a lost response is retried with the same Idempotency-Key and the payment lands once', async () => {
    const lan = await seedCustomer({ name: 'Chị Lan', owes: 100000 });
    const real = debtsApi.createRepayment;
    const create = jest
      .spyOn(debtsApi, 'createRepayment')
      .mockImplementationOnce(async (...args) => {
        await real(...args);
        throw new TypeError('response lost');
      });
    await renderWithProviders(<CustomerScreen id={lan.id} />);
    await screen.findByLabelText('Đang nợ 100.000đ');
    await press('Thu nợ');
    await press('Xác nhận thu nợ');
    expect(
      await screen.findByText('Không ghi được khoản thu. Thử lại.'),
    ).toBeOnTheScreen();
    await press('Xác nhận thu nợ');
    await sheetClosed('Thu nợ');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![2]).toBe(create.mock.calls[0]![2]);
    expect((await debtsApi.getCustomer(lan.id)).balance).toBe(0);
    expect(await screen.findByLabelText('Hết nợ 0đ')).toBeOnTheScreen();
  });

  test('every sheet open gets its own key; an edited retry is a new operation', async () => {
    const lan = await seedCustomer({ name: 'Chị Lan', owes: 100000 });
    const create = jest
      .spyOn(debtsApi, 'createRepayment')
      .mockRejectedValue(new TypeError('offline'));
    await renderWithProviders(<CustomerScreen id={lan.id} />);
    await screen.findByLabelText('Đang nợ 100.000đ');
    await press('Thu nợ');
    await press('Xác nhận thu nợ');
    await screen.findByText('Không ghi được khoản thu. Thử lại.');
    await type('Số tiền thu', '40000');
    await press('Xác nhận thu nợ');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await press('Đóng');
    await press('Thu nợ');
    await press('Xác nhận thu nợ');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    await act(async () => {});
    const keys = create.mock.calls.map((call) => call[2]);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('Nhắc nợ', () => {
  test('opens the system share sheet with the reminder text', async () => {
    const lan = await renderLan();
    const share = jest.spyOn(Share, 'share').mockResolvedValue({
      action: Share.sharedAction,
      activityType: undefined,
    });
    await press('Nhắc nợ');
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const expected = buildReminderText(
      await debtsApi.getCustomer(lan.id),
      await getStore(),
    );
    expect(share).toHaveBeenCalledWith({ message: expected });
    expect(expected).toContain('Chào Chị Lan, Tạp hóa Cô Ba xin nhắc');
    expect(expected).toContain('105.000đ');
    expect(expected).toContain('VCB');
    expect(expected).toContain('TRA NO CHI LAN');
  });

  test('is disabled when nothing is owed', async () => {
    const mai = await seedCustomer({ name: 'Cô Mai' });
    const share = jest.spyOn(Share, 'share');
    await renderWithProviders(<CustomerScreen id={mai.id} />);
    await screen.findByLabelText('Hết nợ 0đ');
    expect(screen.getByRole('button', { name: 'Nhắc nợ' })).toBeDisabled();
    await press('Nhắc nợ');
    expect(share).not.toHaveBeenCalled();
  });

  test('says so when the share sheet cannot open', async () => {
    await renderLan();
    jest.spyOn(Share, 'share').mockRejectedValue(new Error('no share'));
    await press('Nhắc nợ');
    expect(
      await screen.findByText('Không mở được chia sẻ. Thử lại.'),
    ).toBeOnTheScreen();
  });
});

describe('Điều chỉnh (Lead)', () => {
  test('raises the debt with a reason and updates the balance', async () => {
    const lan = await renderLan();
    const adjust = jest.spyOn(debtsApi, 'createDebtAdjustment');
    await press('Điều chỉnh số dư (Chủ)');
    expect(
      screen.getByRole('header', { name: 'Điều chỉnh sổ nợ' }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Tăng nợ' })).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Xác nhận điều chỉnh' }),
    ).toBeDisabled();
    await type('Số tiền điều chỉnh', '10000');
    expect(
      screen.getByRole('button', { name: 'Xác nhận điều chỉnh' }),
    ).toBeDisabled();
    await type('Lý do', '  Ghi thiếu  ');
    await press('Xác nhận điều chỉnh');
    await sheetClosed('Điều chỉnh sổ nợ');
    expect(adjust).toHaveBeenCalledWith(
      lan.id,
      { amount: 10000, reason: 'Ghi thiếu' },
      expect.any(String),
    );
    expect(await screen.findByLabelText('Đang nợ 115.000đ')).toBeOnTheScreen();
  });

  test('lowers the debt as a negative amount', async () => {
    const lan = await renderLan();
    const adjust = jest.spyOn(debtsApi, 'createDebtAdjustment');
    await press('Điều chỉnh số dư (Chủ)');
    await fireEvent.press(screen.getByRole('radio', { name: 'Giảm nợ' }));
    await type('Số tiền điều chỉnh', '5000');
    await type('Lý do', 'Giảm giá');
    await press('Xác nhận điều chỉnh');
    await sheetClosed('Điều chỉnh sổ nợ');
    expect(adjust).toHaveBeenCalledWith(
      lan.id,
      { amount: -5000, reason: 'Giảm giá' },
      expect.any(String),
    );
    expect(await screen.findByLabelText('Đang nợ 100.000đ')).toBeOnTheScreen();
  });

  test('a retry after a lost response reuses the key and adjusts once', async () => {
    const lan = await renderLan();
    const real = debtsApi.createDebtAdjustment;
    const adjust = jest
      .spyOn(debtsApi, 'createDebtAdjustment')
      .mockImplementationOnce(async (...args) => {
        await real(...args);
        throw new TypeError('response lost');
      });
    await press('Điều chỉnh số dư (Chủ)');
    await type('Số tiền điều chỉnh', '10000');
    await type('Lý do', 'Ghi thiếu');
    await press('Xác nhận điều chỉnh');
    expect(
      await screen.findByText('Không ghi được điều chỉnh. Thử lại.'),
    ).toBeOnTheScreen();
    await press('Xác nhận điều chỉnh');
    await sheetClosed('Điều chỉnh sổ nợ');
    expect(adjust.mock.calls[1]![2]).toBe(adjust.mock.calls[0]![2]);
    expect((await debtsApi.getCustomer(lan.id)).balance).toBe(115000);
  });
});

describe('Sửa thông tin', () => {
  test('sends only what changed, clearing the phone with null', async () => {
    const lan = await renderLan();
    const update = jest.spyOn(debtsApi, 'updateCustomer');
    await press('Sửa thông tin');
    expect(screen.getByLabelText('Tên khách hàng')).toHaveDisplayValue(
      'Chị Lan',
    );
    expect(
      screen.getByLabelText('Số điện thoại (không bắt buộc)'),
    ).toHaveDisplayValue('0901234567');
    expect(
      screen.getByLabelText('Ghi chú (không bắt buộc)'),
    ).toHaveDisplayValue('Hay quên');
    expect(
      screen.getByLabelText('Hạn mức nợ (không bắt buộc)'),
    ).toHaveDisplayValue('500000');
    expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toBeDisabled();
    await type('Tên khách hàng', 'Chị Lan Anh');
    await type('Số điện thoại (không bắt buộc)', '');
    await type('Hạn mức nợ (không bắt buộc)', '300000');
    await press('Lưu thay đổi');
    await sheetClosed('Sửa khách hàng');
    expect(update).toHaveBeenCalledWith(lan.id, {
      name: 'Chị Lan Anh',
      phone: null,
      credit_limit: 300000,
    });
    expect(
      await screen.findByRole('header', { name: 'Chị Lan Anh' }),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Hạn mức nợ 300.000đ')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Điện thoại/)).toBeNull();
  });

  test('an empty credit limit removes the limit; the name cannot be blank', async () => {
    const lan = await renderLan();
    const update = jest.spyOn(debtsApi, 'updateCustomer');
    await press('Sửa thông tin');
    await type('Tên khách hàng', '   ');
    expect(screen.getByRole('button', { name: 'Lưu thay đổi' })).toBeDisabled();
    await type('Tên khách hàng', 'Chị Lan');
    await type('Hạn mức nợ (không bắt buộc)', '');
    await press('Lưu thay đổi');
    await sheetClosed('Sửa khách hàng');
    expect(update).toHaveBeenCalledWith(lan.id, { credit_limit: null });
  });

  test('a failed save keeps the sheet open', async () => {
    await renderLan();
    jest
      .spyOn(debtsApi, 'updateCustomer')
      .mockRejectedValueOnce(new Error('x'));
    await press('Sửa thông tin');
    await type('Ghi chú (không bắt buộc)', 'Mới');
    await press('Lưu thay đổi');
    expect(
      await screen.findByText('Không lưu được. Thử lại.'),
    ).toBeOnTheScreen();
    await press('Lưu thay đổi');
    await sheetClosed('Sửa khách hàng');
    expect(await screen.findByLabelText('Ghi chú Mới')).toBeOnTheScreen();
  });

  test('the Lead can archive and unarchive', async () => {
    const lan = await renderLan();
    const update = jest.spyOn(debtsApi, 'updateCustomer');
    await press('Sửa thông tin');
    const archive = () =>
      screen.getByRole('switch', { name: 'Lưu trữ khách hàng' });
    expect(archive()).not.toBeChecked();
    await fireEvent.press(archive());
    expect(archive()).toBeChecked();
    await press('Lưu thay đổi');
    await sheetClosed('Sửa khách hàng');
    expect(update).toHaveBeenLastCalledWith(lan.id, { archived: true });
    expect(await screen.findByText('Đã lưu trữ')).toBeOnTheScreen();
    await press('Sửa thông tin');
    expect(archive()).toBeChecked();
    await fireEvent.press(archive());
    await press('Lưu thay đổi');
    await sheetClosed('Sửa khách hàng');
    expect(update).toHaveBeenLastCalledWith(lan.id, { archived: false });
    await waitFor(() => expect(screen.queryByText('Đã lưu trữ')).toBeNull());
  });
});

describe('as a Seller', () => {
  test('can collect, remind and edit, but not adjust or archive', async () => {
    const lan = await seedLan();
    actAsSeller();
    await renderWithProviders(<CustomerScreen id={lan.id} />);
    await screen.findByLabelText('Đang nợ 105.000đ');
    expect(screen.getByRole('button', { name: 'Thu nợ' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Nhắc nợ' })).toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: 'Điều chỉnh số dư (Chủ)' }),
    ).toBeNull();
    await press('Sửa thông tin');
    expect(screen.getByLabelText('Tên khách hàng')).toBeOnTheScreen();
    expect(
      screen.queryByRole('switch', { name: 'Lưu trữ khách hàng' }),
    ).toBeNull();
  });

  test('a profile edit never sends archived', async () => {
    const lan = await seedLan();
    actAsSeller();
    const update = jest.spyOn(debtsApi, 'updateCustomer');
    await renderWithProviders(<CustomerScreen id={lan.id} />);
    await screen.findByLabelText('Đang nợ 105.000đ');
    await press('Sửa thông tin');
    await type('Ghi chú (không bắt buộc)', 'Mới');
    await press('Lưu thay đổi');
    await sheetClosed('Sửa khách hàng');
    expect(update).toHaveBeenCalledWith(lan.id, { note: 'Mới' });
  });
});

describe('sheets', () => {
  test('the close circle and the scrim dismiss a sheet', async () => {
    await renderLan();
    await press('Thu nợ');
    await press('Đóng');
    await sheetClosed('Thu nợ');
    await press('Điều chỉnh số dư (Chủ)');
    await fireEvent.press(screen.getByTestId('sheet-scrim'));
    await sheetClosed('Điều chỉnh sổ nợ');
  });

  test('the action buttons are at least 48 dp tall', async () => {
    await renderLan();
    for (const name of ['Thu nợ', 'Nhắc nợ', 'Điều chỉnh số dư (Chủ)'])
      expect(screen.getByRole('button', { name })).toHaveStyle({
        minHeight: 56,
      });
  });
});

test('English labels follow the language', async () => {
  useSettingsStore.setState({ language: 'en' });
  await seedLan().then((lan) =>
    renderWithProviders(<CustomerScreen id={lan.id} />),
  );
  expect(await screen.findByLabelText('Owes 105.000đ')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Collect' })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Remind' })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Adjust balance (Owner)' })).toBeOnTheScreen();
  expect(screen.getByRole('header', { name: 'History' })).toBeOnTheScreen();
  await waitFor(() => expect(ledgerRows()).toHaveLength(5));
  expect(ledgerRows()[1]).toBe(
    `Repayment · Cash, -20.000đ, ${today()}, Balance 100.000đ`,
  );
});

test('text size setting scales the amount input', async () => {
  useSettingsStore.setState({ fontScale: 1.5 });
  await renderLan();
  await press('Thu nợ');
  expect(screen.getByLabelText('Số tiền thu')).toHaveStyle({ fontSize: 27 });
});
