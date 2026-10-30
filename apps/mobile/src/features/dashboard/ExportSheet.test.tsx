import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderWithProviders } from '@/test/render';
import * as api from '@/lib/api/salesActions';
import { businessDate } from '@/lib/date';
import { shareExport } from './shareExport';
import { ExportSheet } from './ExportSheet';

jest.mock('./shareExport', () => ({
  shareExport: jest.fn().mockResolvedValue(undefined),
}));
afterEach(() => jest.restoreAllMocks());
test.each(['CSV', 'XLSX'])(
  'exports the selected range as %s and shares bytes',
  async (format) => {
    const bytes = new Uint8Array([0x50, 0x4b, 255]).buffer;
    const request = jest
      .spyOn(api, 'exportTransactions')
      .mockResolvedValue(bytes);
    const close = jest.fn();
    await renderWithProviders(<ExportSheet onClose={close} />);
    await fireEvent.changeText(
      screen.getByLabelText('Từ ngày (YYYY-MM-DD)'),
      '2026-10-01',
    );
    await fireEvent.changeText(
      screen.getByLabelText('Đến ngày (YYYY-MM-DD)'),
      '2026-10-27',
    );
    await fireEvent.press(screen.getByRole('radio', { name: format }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Tải và chia sẻ' }),
    );
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith({
      from: '2026-10-01',
      to: '2026-10-27',
      format: format.toLowerCase(),
    });
    expect(shareExport).toHaveBeenCalledWith(
      bytes,
      `giao-dich-2026-10-01-2026-10-27.${format.toLowerCase()}`,
      format === 'CSV'
        ? 'text/csv'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  },
);
test('rejects reversed and impossible dates before downloading', async () => {
  const request = jest.spyOn(api, 'exportTransactions');
  await renderWithProviders(<ExportSheet onClose={jest.fn()} />);
  expect(screen.getByLabelText('Đến ngày (YYYY-MM-DD)').props.value).toBe(
    businessDate(),
  );
  await fireEvent.changeText(
    screen.getByLabelText('Từ ngày (YYYY-MM-DD)'),
    '2026-02-30',
  );
  expect(screen.getByRole('button', { name: 'Tải và chia sẻ' })).toBeDisabled();
  await fireEvent.changeText(
    screen.getByLabelText('Từ ngày (YYYY-MM-DD)'),
    '2026-10-28',
  );
  await fireEvent.changeText(
    screen.getByLabelText('Đến ngày (YYYY-MM-DD)'),
    '2026-10-27',
  );
  expect(screen.getByRole('button', { name: 'Tải và chia sẻ' })).toBeDisabled();
  expect(request).not.toHaveBeenCalled();
});
test('failed download keeps dates and allows retry', async () => {
  const request = jest
    .spyOn(api, 'exportTransactions')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(new ArrayBuffer(0));
  const close = jest.fn();
  await renderWithProviders(<ExportSheet onClose={close} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Tải và chia sẻ' }));
  await screen.findByText('Không xuất được file. Kiểm tra kết nối và thử lại.');
  expect(close).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Tải và chia sẻ' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(request).toHaveBeenCalledTimes(2);
});
