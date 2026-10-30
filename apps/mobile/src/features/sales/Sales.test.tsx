import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { createTestQueryClient, renderWithProviders } from '@/test/render';
import { getMockDb } from '@/test/mock/db';
import { testSession, setTestMembership } from '@/test/session';
import { keys } from '@/lib/api/keys';
import { getApiClient } from '@/lib/api/client';
import * as ledger from '@/lib/api/ledger';
import { RecentSalesScreen } from './RecentSalesScreen';
import { SaleDetailScreen } from './SaleDetailScreen';
import { saleStamp } from './kit';
import { businessDate } from '@/lib/date';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));
afterEach(() => jest.restoreAllMocks());
const reply = (data: object) =>
  ({
    data,
    response: { ok: true, status: 200, headers: new Headers() },
  }) as never;
function saleId() {
  const sale = getMockDb().sales.find((s) => s.status === 'completed')!;
  jest.mocked(useLocalSearchParams).mockReturnValue({ id: sale.id });
  return sale;
}
test('recent sales opens detail and reports, and shows completed and voided statuses', async () => {
  const sale = saleId();
  await renderWithProviders(<RecentSalesScreen />);
  await fireEvent.press(
    await screen.findByRole('button', { name: `${sale.code}, Đã thanh toán` }),
  );
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/sale/[id]',
    params: { id: sale.id },
  });
  await fireEvent.press(
    screen.getByRole('button', { name: 'Quay lại Báo cáo' }),
  );
  expect(router.replace).toHaveBeenCalledWith('/dashboard');
});
test('recent sales empty and retry states', async () => {
  getMockDb().sales = [];
  jest.spyOn(ledger, 'listSales').mockRejectedValueOnce(new Error('offline'));
  await renderWithProviders(<RecentSalesScreen />);
  await screen.findByText('Không tải được dữ liệu.');
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  await screen.findByText('Chưa có đơn bán hàng.');
});
test('Lead must supply a nonblank reason and confirm; void refreshes reports, stock and debts', async () => {
  const sale = saleId();
  const qc = createTestQueryClient();
  qc.setQueryData(keys.reports.today(), { stale: true });
  const invalidate = jest.spyOn(qc, 'invalidateQueries');
  const voidRequest = jest.spyOn(getApiClient(), 'voidSale');
  await renderWithProviders(<SaleDetailScreen />, qc);
  await screen.findByText(`Đơn ${sale.code}`);
  expect(
    screen.getByRole('button', { name: 'Hủy đơn / hoàn tiền' }),
  ).toBeDisabled();
  await fireEvent.changeText(screen.getByLabelText('Lý do hủy'), '   ');
  expect(
    screen.getByRole('button', { name: 'Hủy đơn / hoàn tiền' }),
  ).toBeDisabled();
  await fireEvent.changeText(
    screen.getByLabelText('Lý do hủy'),
    ' Khách trả hàng ',
  );
  await fireEvent.press(
    screen.getByRole('button', { name: 'Hủy đơn / hoàn tiền' }),
  );
  expect(voidRequest).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Giữ đơn' }));
  expect(voidRequest).not.toHaveBeenCalled();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Hủy đơn / hoàn tiền' }),
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận hủy' }));
  await screen.findByText('Đã hủy');
  expect(voidRequest).toHaveBeenCalledWith(sale.id, {
    reason: 'Khách trả hàng',
  });
  expect(
    screen.queryByRole('button', { name: 'Hủy đơn / hoàn tiền' }),
  ).toBeNull();
  expect(screen.getByText('Đã hủy · Khách trả hàng')).toBeOnTheScreen();
  for (const queryKey of [
    keys.reports.all(),
    keys.sales.all(),
    keys.stock.all(),
    keys.customers.all(),
    keys.debtSummary(),
  ])
    expect(invalidate).toHaveBeenCalledWith({ queryKey });
});
test('void failure retains reason and permits retry', async () => {
  saleId();
  jest
    .spyOn(getApiClient(), 'voidSale')
    .mockRejectedValueOnce(new Error('offline'));
  await renderWithProviders(<SaleDetailScreen />);
  await fireEvent.changeText(
    await screen.findByLabelText('Lý do hủy'),
    'Khách trả hàng',
  );
  await fireEvent.press(
    screen.getByRole('button', { name: 'Hủy đơn / hoàn tiền' }),
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận hủy' }));
  // The confirmation remains open after failure, with its reason and retry action.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Xác nhận hủy' })).toBeEnabled(),
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận hủy' }));
  await screen.findByText('Đã hủy');
});
test('a missing sale says so at once, with a way back and no retry', async () => {
  jest.mocked(useLocalSearchParams).mockReturnValue({ id: 'not-found' });
  await renderWithProviders(<SaleDetailScreen />);
  await screen.findByText('Không tìm thấy đơn này. Có thể nó đã bị xóa.');
  expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Về đơn gần đây' }));
  expect(router.replace).toHaveBeenCalledWith('/sales');
});
test('a server failure keeps the generic retry state', async () => {
  saleId();
  jest.spyOn(getApiClient(), 'getSale').mockResolvedValue({
    error: { error: 'boom' },
    response: { ok: false, status: 500, headers: new Headers() },
  } as never);
  await renderWithProviders(<SaleDetailScreen />);
  await screen.findByText('Không tải được dữ liệu.');
  expect(screen.getByRole('button', { name: 'Thử lại' })).toBeEnabled();
});
test("a seller may void their own sale of today (spec e4 M2) but not a colleague's", async () => {
  const sale = saleId();
  const session = testSession();
  setTestMembership({
    ...session,
    member: { ...session.member, role: 'seller' },
  });
  const own = {
    ...sale,
    member_id: session.member.id,
    business_date: businessDate(),
  };
  jest.spyOn(getApiClient(), 'getSale').mockResolvedValue(reply(own));
  const view = await renderWithProviders(<SaleDetailScreen />);
  expect(
    await screen.findByRole('button', { name: 'Hủy đơn / hoàn tiền' }),
  ).toBeOnTheScreen();
  view.unmount();
  jest
    .spyOn(getApiClient(), 'getSale')
    .mockResolvedValue(reply({ ...own, member_id: 'someone-else' }));
  await renderWithProviders(<SaleDetailScreen />);
  await screen.findByText(`Đơn ${sale.code}`);
  expect(screen.queryByLabelText('Lý do hủy')).toBeNull();
});
test('a seller cannot void their own sale from an earlier day', async () => {
  const sale = saleId();
  const session = testSession();
  setTestMembership({
    ...session,
    member: { ...session.member, role: 'seller' },
  });
  jest.spyOn(getApiClient(), 'getSale').mockResolvedValue(
    reply({
      ...sale,
      member_id: session.member.id,
      business_date: '2020-01-01',
    }),
  );
  await renderWithProviders(<SaleDetailScreen />);
  await screen.findByText(`Đơn ${sale.code}`);
  expect(screen.queryByLabelText('Lý do hủy')).toBeNull();
});
test('the sale stamp is dd/MM · HH:mm in Vietnam time', () => {
  expect(saleStamp('2026-10-27T03:35:00Z')).toBe('27/10 · 10:35');
});
