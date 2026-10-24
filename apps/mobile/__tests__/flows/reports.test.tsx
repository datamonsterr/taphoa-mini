import {
  getDayClose,
  getReportSummary,
  getTodayReport,
  summaryRange,
} from '@/lib/api';
import { businessDate } from '@/lib/date';
import { formatVnd } from '@/lib/format';
import { fireEvent, renderApp, screen, waitFor } from '@/test/router';

const currentWeek = async () => {
  const { buckets } = await getReportSummary(summaryRange('week'));
  return buckets.at(-1)!;
};

test('dashboard, add expense, then close the day', async () => {
  const app = await renderApp('/dashboard');
  const today = await getTodayReport();

  // Dashboard shows today's seeded revenue.
  expect(
    await screen.findByLabelText(
      `Doanh thu ${formatVnd(today.revenue)}, ${today.sales_count} đơn`,
    ),
  ).toBeOnTheScreen();

  // Switch to the week.
  await fireEvent.press(screen.getByRole('radio', { name: 'Tuần' }));
  expect(await screen.findByText('Tuần này')).toBeOnTheScreen();
  const { expenses: expensesBefore, net: netBefore } = await currentWeek();
  expect(
    await screen.findByLabelText(`Chi ${formatVnd(expensesBefore)}`),
  ).toBeOnTheScreen();

  // Add an expense of 50.000 for electricity.
  await fireEvent.press(screen.getByRole('button', { name: 'Thêm khoản chi' }));
  await waitFor(() => expect(app.getPathname()).toBe('/expense'));
  await fireEvent.press(screen.getByRole('button', { name: '5' }));
  await fireEvent.press(screen.getByRole('button', { name: '000' }));
  expect(screen.getByLabelText('Số tiền chi')).toHaveTextContent('−5.000đ');
  await fireEvent.press(screen.getByRole('button', { name: '0' }));
  expect(screen.getByLabelText('Số tiền chi')).toHaveTextContent('−50.000đ');
  await fireEvent.press(screen.getByRole('radio', { name: 'Điện' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu khoản chi' }));
  await waitFor(() => expect(app.getPathname()).toBe('/dashboard'));

  // Expense and net update from the invalidated queries.
  const after = expensesBefore + 50000;
  expect(
    await screen.findByLabelText(`Chi ${formatVnd(after)}`),
  ).toBeOnTheScreen();
  expect(
    screen.getByLabelText(`Lãi ${formatVnd(netBefore - 50000)}`),
  ).toBeOnTheScreen();

  // Close the day with counted cash equal to the expected cash.
  await fireEvent.press(screen.getByRole('radio', { name: 'Ngày' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Chốt sổ' }));
  await waitFor(() => expect(app.getPathname()).toBe('/close'));
  const { expected_cash: expected } = await getTodayReport();
  await screen.findByLabelText(`Tiền mặt dự kiến ${formatVnd(expected)}`);
  for (const digit of String(expected)) {
    await fireEvent.press(screen.getByRole('button', { name: digit }));
  }
  expect(screen.getByLabelText('Khớp')).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Chốt sổ hôm nay' }),
  );
  await waitFor(() => expect(app.getPathname()).toBe('/dashboard'));

  expect(await getDayClose(businessDate())).toMatchObject({
    counted_cash: expected,
    expected_cash: expected,
    difference: 0,
  });
});
