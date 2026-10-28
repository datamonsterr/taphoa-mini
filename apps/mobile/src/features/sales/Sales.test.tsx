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

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));
afterEach(() => jest.restoreAllMocks());
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
  await screen.findByText(`Chi tiết đơn · ${sale.code}`);
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
  expect(screen.getByText('Khách trả hàng')).toBeOnTheScreen();
  for (const queryKey of [
    keys.reports.all(),
    keys.sales.all(),
    keys.stock.all(),
    keys.customers.all(),
    keys.debtSummary(),
  ])
    expect(invalidate).toHaveBeenCalledWith({ queryKey });
});
test('Seller can view detail but cannot void', async () => {
  const sale = saleId();
  const session = testSession();
  setTestMembership({
    ...session,
    member: { ...session.member, role: 'seller' },
  });
  await renderWithProviders(<SaleDetailScreen />);
  await screen.findByText(`Chi tiết đơn · ${sale.code}`);
  expect(screen.queryByLabelText('Lý do hủy')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Hủy đơn / hoàn tiền' }),
  ).toBeNull();
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
test('unknown sale has a retry state', async () => {
  jest.mocked(useLocalSearchParams).mockReturnValue({ id: 'not-found' });
  await renderWithProviders(<SaleDetailScreen />);
  await screen.findByText('Không tải được dữ liệu.');
  expect(screen.getByRole('button', { name: 'Thử lại' })).toBeEnabled();
});
