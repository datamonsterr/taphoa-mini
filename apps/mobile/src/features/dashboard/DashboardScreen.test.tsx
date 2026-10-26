import {
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import { router } from 'expo-router';

import * as debtsApi from '@/lib/api/debts';
import * as ledger from '@/lib/api/ledger';
import * as review from '@/lib/api/review';
import { resetApiClient } from '@/lib/api';
import { formatVnd } from '@/lib/format';
import { resetMockDb } from '@/test/mock';
import { seedCustomer } from '@/test/debts';
import { renderWithProviders } from '@/test/render';
import { testSession, setTestMembership } from '@/test/session';
import { useSettingsStore } from '@/stores/settings';
import { colors } from '@/theme';

import { DashboardScreen } from './DashboardScreen';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

beforeEach(() => {
  resetMockDb();
  resetApiClient();
  jest.clearAllMocks();
});

afterEach(() => jest.restoreAllMocks());

const ready = () => screen.findByLabelText(/^Doanh thu \d/);

test('opens import receipt history from the dashboard', async () => {
  await renderWithProviders(<DashboardScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Hóa đơn nhập' }));
  expect(router.push).toHaveBeenCalledWith('/receipts');
  await ready();
});

test.each([
  [false, false],
  [true, true],
] as const)(
  'receipt entry follows can_enroll=%s for sellers',
  async (can_enroll, visible) => {
    const session = testSession();
    setTestMembership({
      ...session!,
      member: { ...session!.member, role: 'seller', can_enroll },
    });
    await renderWithProviders(<DashboardScreen />);
    if (visible) {
      expect(
        screen.getByRole('button', { name: 'Hóa đơn nhập' }),
      ).toBeOnTheScreen();
    } else {
      expect(screen.queryByRole('button', { name: 'Hóa đơn nhập' })).toBeNull();
    }
  },
);

test('shows a skeleton while loading', async () => {
  let release: () => void = () => {};
  const real = ledger.getTodayReport;
  jest.spyOn(ledger, 'getTodayReport').mockImplementationOnce(
    (date) =>
      new Promise((resolve) => {
        release = () => resolve(real(date));
      }),
  );
  await renderWithProviders(<DashboardScreen />);
  expect(screen.getByTestId('dashboard-skeleton')).toBeOnTheScreen();
  release();
  await ready();
  expect(screen.queryByTestId('dashboard-skeleton')).toBeNull();
});

test('shows the seeded totals for today', async () => {
  await renderWithProviders(<DashboardScreen />);
  const today = await ledger.getTodayReport();
  await ready();
  expect(
    screen.getByLabelText(
      `Doanh thu ${formatVnd(today.revenue)}, ${today.sales_count} đơn`,
    ),
  ).toBeOnTheScreen();
  expect(
    screen.getByLabelText(`Tiền mặt ${formatVnd(today.cash_revenue)}`),
  ).toBeOnTheScreen();
  expect(
    screen.getByLabelText(`Chuyển khoản ${formatVnd(today.transfer_revenue)}`),
  ).toBeOnTheScreen();
  expect(
    screen.getByLabelText(`Chi ${formatVnd(today.expenses)}`),
  ).toBeOnTheScreen();
  expect(
    screen.getByLabelText(`Lãi ${formatVnd(today.net)}`),
  ).toBeOnTheScreen();
  expect(screen.queryByTestId('dashboard-skeleton')).toBeNull();
  expect(screen.getByRole('header', { name: 'Báo cáo' })).toBeOnTheScreen();
  expect(screen.getByText('Hôm nay')).toBeOnTheScreen();
});

test('draws 7 day bars labelled with weekdays', async () => {
  await renderWithProviders(<DashboardScreen />);
  await ready();
  expect(
    screen.getByRole('image', { name: 'Doanh thu và chi 7 ngày' }),
  ).toBeOnTheScreen();
  expect(screen.getAllByTestId(/^bar-revenue-/)).toHaveLength(7);
  expect(screen.getAllByTestId(/^bar-expense-/)).toHaveLength(7);
  for (const day of ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']) {
    expect(screen.getAllByText(day).length).toBeGreaterThan(0);
  }
});

test('Tuần and Tháng switch the title, the chart and the totals', async () => {
  await renderWithProviders(<DashboardScreen />);
  await ready();
  await fireEvent.press(screen.getByRole('radio', { name: 'Tuần' }));
  expect(await screen.findByText('Tuần này')).toBeOnTheScreen();
  expect(
    await screen.findByRole('image', { name: 'Doanh thu và chi 6 tuần' }),
  ).toBeOnTheScreen();
  expect(screen.getAllByTestId(/^bar-revenue-/)).toHaveLength(6);
  expect(screen.getByLabelText(/^Doanh thu \d.*đơn$/)).toBeOnTheScreen();
  expect(screen.getByLabelText(/^Tiền mặt /)).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('radio', { name: 'Tháng' }));
  expect(await screen.findByText('Tháng này')).toBeOnTheScreen();
  expect(
    await screen.findByRole('image', { name: 'Doanh thu và chi 6 tháng' }),
  ).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('radio', { name: 'Ngày' }));
  expect(await screen.findByText('Hôm nay')).toBeOnTheScreen();
});

test('the add-expense circle opens the expense sheet', async () => {
  await renderWithProviders(<DashboardScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Thêm khoản chi' }));
  expect(router.push).toHaveBeenCalledWith('/expense');
});

test('Chốt sổ opens the close sheet', async () => {
  await renderWithProviders(<DashboardScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Chốt sổ' }));
  expect(router.push).toHaveBeenCalledWith('/close');
});

test('a failed report shows an error that retries', async () => {
  const spy = jest
    .spyOn(ledger, 'getTodayReport')
    .mockRejectedValueOnce(new Error('offline'));
  await renderWithProviders(<DashboardScreen />);
  expect(await screen.findByText('Không tải được báo cáo')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  expect(await ready()).toBeOnTheScreen();
  expect(spy).toHaveBeenCalledTimes(2);
});

test('a negative net uses the danger colour, a positive one stays green', async () => {
  const real = ledger.getTodayReport;
  jest.spyOn(ledger, 'getTodayReport').mockImplementation(async (date) => ({
    ...(await real(date)),
    net: -25000,
  }));
  await renderWithProviders(<DashboardScreen />);
  const net = await screen.findByLabelText(`Lãi ${formatVnd(-25000)}`);
  expect(net).toHaveStyle({ backgroundColor: colors.dangerSoft });
  expect(within(net).getByText(formatVnd(-25000))).toHaveStyle({
    color: colors.danger,
  });
});

test('a positive net keeps the success colour', async () => {
  const today = await ledger.getTodayReport();
  await renderWithProviders(<DashboardScreen />);
  const net = await screen.findByLabelText(`Lãi ${formatVnd(today.net)}`);
  expect(net).toHaveStyle({ backgroundColor: colors.successSoft });
});

describe('alerts', () => {
  test('price below cost expands a list; a row opens the product', async () => {
    await renderWithProviders(<DashboardScreen />);
    const alerts = await ledger.listAlerts('open');
    const pill = await screen.findByRole('button', {
      name: `${alerts.length} món giá bán dưới giá nhập`,
    });
    expect(
      screen.queryByRole('button', { name: alerts[0]!.product_name! }),
    ).toBeNull();
    await fireEvent.press(pill);
    await fireEvent.press(
      await screen.findByRole('button', { name: alerts[0]!.product_name! }),
    );
    expect(router.push).toHaveBeenCalledWith(
      `/product/${alerts[0]!.product_id}`,
    );
    await fireEvent.press(pill);
    expect(
      screen.queryByRole('button', { name: alerts[0]!.product_name! }),
    ).toBeNull();
  });

  test('sold without catalog expands the manual lines', async () => {
    await renderWithProviders(<DashboardScreen />);
    const lines = (await review.listManualLines({ status: 'open' })).items;
    const pill = await screen.findByRole('button', {
      name: `${lines.length} món bán không có trong kho`,
    });
    await fireEvent.press(pill);
    expect(
      await screen.findByText(
        `${lines[0]!.manual_label} × ${lines[0]!.quantity}`,
      ),
    ).toBeOnTheScreen();
    // switching list closes the other one
    await fireEvent.press(
      screen.getByRole('button', { name: /món giá bán dưới giá nhập$/ }),
    );
    expect(
      screen.queryByText(`${lines[0]!.manual_label} × ${lines[0]!.quantity}`),
    ).toBeNull();
  });

  test('a sold-without-catalog item opens enroll prefilled with its name, price and crop', async () => {
    const [line] = (await review.listManualLines({ status: 'open' })).items;
    jest.spyOn(review, 'listManualLines').mockResolvedValue({
      items: [
        {
          ...line!,
          crop_image: { url: 'https://mock.local/crop.jpg' } as never,
        },
      ],
      next_cursor: null,
    });
    await renderWithProviders(<DashboardScreen />);
    await fireEvent.press(
      await screen.findByRole('button', {
        name: /món bán không có trong kho$/,
      }),
    );
    await fireEvent.press(
      await screen.findByRole('button', {
        name: new RegExp(`^${line!.manual_label} ×`),
      }),
    );
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/enroll',
      params: {
        manualLineId: line!.line_id,
        price: String(line!.unit_price),
        name: line!.manual_label,
        cropUrl: 'https://mock.local/crop.jpg',
      },
    });
  });

  test('a failed alert query shows a retry', async () => {
    jest
      .spyOn(review, 'listManualLines')
      .mockRejectedValueOnce(new Error('offline'));
    await renderWithProviders(<DashboardScreen />);
    expect(
      await screen.findByText('Không tải được cảnh báo'),
    ).toBeOnTheScreen();
    await fireEvent.press(
      screen.getByRole('button', { name: /Không tải được cảnh báo/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /món giá bán dưới giá nhập$/ }),
      ).toBeOnTheScreen(),
    );
  });

  test('shows a skeleton row while alerts load', async () => {
    let release: () => void = () => {};
    const real = review.listManualLines;
    jest.spyOn(review, 'listManualLines').mockImplementationOnce(
      (params) =>
        new Promise((resolve) => {
          release = () => resolve(real(params));
        }),
    );
    await renderWithProviders(<DashboardScreen />);
    expect(screen.getByTestId('alerts-skeleton')).toBeOnTheScreen();
    release();
    await screen.findByRole('button', { name: /món giá bán dưới giá nhập$/ });
  });
});

test('English: period chips and the group follow the language', async () => {
  useSettingsStore.setState({ language: 'en' });
  await renderWithProviders(<DashboardScreen />);
  expect(await screen.findByRole('radio', { name: 'Week' })).toBeOnTheScreen();
  expect(screen.getByText('Month')).toBeOnTheScreen();
  expect(screen.queryByText('Tuần')).toBeNull();
});

describe('as a Seller', () => {
  beforeEach(() => {
    const session = testSession();
    setTestMembership({
      ...session!,
      member: { ...session!.member, role: 'seller' },
    });
  });

  test('never asks for Lead-only data (alerts, review queue) and hides the day close', async () => {
    const alerts = jest.spyOn(ledger, 'listAlerts');
    const manual = jest.spyOn(review, 'listManualLines');
    await renderWithProviders(<DashboardScreen />);
    await ready();
    await waitFor(() =>
      expect(screen.queryByTestId('alerts-skeleton')).toBeNull(),
    );
    expect(alerts).not.toHaveBeenCalled();
    expect(manual).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Chốt sổ' })).toBeNull();
    expect(screen.queryByLabelText(/món bán không có trong kho/)).toBeNull();
    expect(screen.queryByLabelText(/món giá bán dưới giá nhập/)).toBeNull();
  });
});

describe('debt book card', () => {
  test('shows the total outstanding and the overdue count; a tap opens the debt book', async () => {
    await seedCustomer({ name: 'Chị Lan', owes: 120000, ageDays: 10 });
    await seedCustomer({ name: 'Cô Mai', owes: 30000 });
    await renderWithProviders(<DashboardScreen />);
    const card = await screen.findByRole('button', {
      name: 'Sổ nợ, 150.000đ, 1 khách quá hạn',
    });
    expect(within(card).getByText('Sổ nợ')).toBeOnTheScreen();
    expect(within(card).getByText('150.000đ')).toBeOnTheScreen();
    expect(within(card).getByText('1 khách quá hạn')).toBeOnTheScreen();
    await fireEvent.press(card);
    expect(router.push).toHaveBeenCalledWith('/debts');
  });

  test('stays as a zero card when nobody owes anything, like the other tiles', async () => {
    await renderWithProviders(<DashboardScreen />);
    expect(
      await screen.findByRole('button', {
        name: 'Sổ nợ, 0đ, 0 khách quá hạn',
      }),
    ).toBeOnTheScreen();
  });

  test("a Seller sees it too: debts are every member's", async () => {
    const { session } = useSessionStore.getState();
    useSessionStore.setState({
      session: { ...session!, member: { ...session!.member, role: 'seller' } },
    });
    await seedCustomer({ name: 'Cô Mai', owes: 30000 });
    await renderWithProviders(<DashboardScreen />);
    expect(
      await screen.findByRole('button', {
        name: 'Sổ nợ, 30.000đ, 0 khách quá hạn',
      }),
    ).toBeOnTheScreen();
  });

  test('a failed summary hides the card and leaves the report alone', async () => {
    jest
      .spyOn(debtsApi, 'getDebtSummary')
      .mockRejectedValue(new Error('offline'));
    await renderWithProviders(<DashboardScreen />);
    await ready();
    expect(screen.queryByRole('button', { name: /^Sổ nợ/ })).toBeNull();
  });

  test('English label', async () => {
    useSettingsStore.setState({ language: 'en' });
    await seedCustomer({ name: 'Chị Lan', owes: 120000, ageDays: 10 });
    await renderWithProviders(<DashboardScreen />);
    expect(
      await screen.findByRole('button', {
        name: 'Debt book, 120.000đ, 1 overdue',
      }),
    ).toBeOnTheScreen();
  });
});
