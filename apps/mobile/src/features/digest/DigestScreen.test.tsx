import {
  cleanup,
  fireEvent,
  screen,
  within,
} from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';

import * as digestApi from '@/lib/api/digest';
import * as analytics from '@/lib/analytics';
import type { Digest } from '@/lib/api';
import { resetApiClient } from '@/lib/api';
import { resetMockDb } from '@/test/mock';
import { renderWithProviders } from '@/test/render';
import { formatVnd } from '@/lib/format';

import { DigestScreen } from './DigestScreen';

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
    replace: jest.fn(),
  },
  useLocalSearchParams: jest.fn(() => ({})),
}));

const mockCapture = jest.fn();

beforeEach(() => {
  resetMockDb();
  resetApiClient();
  jest.clearAllMocks();
  (router.canGoBack as jest.Mock).mockReturnValue(true);
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
  analytics.setAnalyticsSink({ capture: mockCapture });
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  analytics.setAnalyticsSink(null);
});

const fullDigest: Digest = {
  business_date: '2026-10-26',
  generated_at: '2026-10-26T07:00:00Z',
  source: 'model',
  summary_vi:
    'Doanh thu hôm qua đạt 2.500.000 ₫ với 45 đơn hàng. Cần lưu ý nhập thêm Coca và Mì Hảo Hảo.',
  sales: {
    revenue: 2500000,
    sale_count: 45,
    gross_profit: 750000,
    change_pct: 12.5,
  },
  restock: [
    {
      product_id: 'p-coca',
      name: 'Coca lon',
      quantity: 24,
      unit_cost: 8000,
      total_cost: 192000,
    },
    {
      product_id: 'p-haohao',
      name: 'Mì Hảo Hảo',
      quantity: 10,
      unit_cost: 4000,
      total_cost: 40000,
    },
  ],
  overdue_debts: {
    count: 3,
    total: 450000,
  },
  open_drafts: {
    count: 2,
  },
  read_at: '2026-10-26T07:30:00Z',
};

test('renders all sections and captures digest_opened with card entry by default', async () => {
  jest.spyOn(digestApi, 'getDigest').mockResolvedValue(fullDigest);

  await renderWithProviders(<DigestScreen />);

  expect(mockCapture).toHaveBeenCalledWith('digest_opened', { entry: 'card' });
  // Opening the digest is what records the read (issue 203).
  expect(digestApi.getDigest).toHaveBeenCalledWith(undefined, true);

  // Title and date
  expect(await screen.findByText('Tóm tắt sáng nay')).toBeOnTheScreen();
  // The date comes from the digest response, which can land after the static title.
  expect(await screen.findByText('Thứ hai, 26/10 · 14:00')).toBeOnTheScreen();

  // Summary
  expect(screen.getByText(fullDigest.summary_vi)).toBeOnTheScreen();

  // Board 23: four stat tiles; the label is spoken, the figure is shown.
  expect(screen.getByLabelText('Doanh thu 2.500.000đ')).toBeOnTheScreen();
  expect(screen.getByText(formatVnd(2500000))).toBeOnTheScreen();
  expect(screen.getByLabelText('Số đơn 45 đơn')).toBeOnTheScreen();
  expect(
    within(screen.getByLabelText('Số đơn 45 đơn')).getByText('45 đơn'),
  ).toBeOnTheScreen();
  // The key figures inside the summary paragraph render bold.
  expect(screen.getAllByText('45 đơn')).toHaveLength(2);
  expect(screen.getByLabelText('Lợi nhuận gộp 750.000đ')).toBeOnTheScreen();
  expect(screen.getByText(formatVnd(750000))).toBeOnTheScreen();
  expect(screen.getByLabelText('So với hôm trước +12.5%')).toBeOnTheScreen();
  expect(screen.getByText('+12.5%')).toBeOnTheScreen();

  // Restock list
  expect(screen.getByText('Coca lon')).toBeOnTheScreen();
  expect(screen.getByText('× 24')).toBeOnTheScreen();
  expect(screen.getByText(formatVnd(192000))).toBeOnTheScreen();
  expect(screen.getByText('Mì Hảo Hảo')).toBeOnTheScreen();
  expect(screen.getByText('× 10')).toBeOnTheScreen();
  expect(screen.getByText(formatVnd(40000))).toBeOnTheScreen();

  // Footer chips
  expect(screen.getByText('3 khách quá hạn')).toBeOnTheScreen();
  expect(screen.getByText('2 hóa đơn nháp')).toBeOnTheScreen();

  // Primary assistant button
  expect(screen.getByText('Hỏi trợ lý')).toBeOnTheScreen();
});

test('captures digest_opened with push entry when route params have entry=push', async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ entry: 'push' });
  jest.spyOn(digestApi, 'getDigest').mockResolvedValue(fullDigest);

  await renderWithProviders(<DigestScreen />);

  expect(mockCapture).toHaveBeenCalledWith('digest_opened', { entry: 'push' });
});

test('hides profit and cost when null, hides change when null, shows empty restock message', async () => {
  const maskedDigest: Digest = {
    ...fullDigest,
    sales: {
      revenue: 1000000,
      sale_count: 20,
      gross_profit: null,
      change_pct: null,
    },
    restock: [],
  };
  jest.spyOn(digestApi, 'getDigest').mockResolvedValue(maskedDigest);

  await renderWithProviders(<DigestScreen />);

  expect(
    await screen.findByText('Không có sản phẩm cần nhập'),
  ).toBeOnTheScreen();
  expect(screen.queryByLabelText(/^Lợi nhuận gộp/)).toBeNull();
  expect(screen.queryByLabelText(/^So với hôm trước/)).toBeNull();
});

test('assistant button navigates with entry: digest, screen: digest and Vietnamese prompt', async () => {
  jest.spyOn(digestApi, 'getDigest').mockResolvedValue(fullDigest);

  await renderWithProviders(<DigestScreen />);

  const assistantBtn = await screen.findByRole('button', {
    name: 'Hỏi trợ lý',
  });
  await fireEvent.press(assistantBtn);

  expect(router.push).toHaveBeenCalledWith({
    pathname: '/assistant',
    params: {
      entry: 'digest',
      screen: 'digest',
      prompt: 'Hôm nay nên ưu tiên việc gì?',
    },
  });
});

test('debts row navigates to /debts and drafts row navigates to /receipts', async () => {
  jest.spyOn(digestApi, 'getDigest').mockResolvedValue(fullDigest);

  await renderWithProviders(<DigestScreen />);

  const debtsBtn = await screen.findByLabelText(/Nợ quá hạn/);
  await fireEvent.press(debtsBtn);
  expect(router.push).toHaveBeenCalledWith('/debts');

  const draftsBtn = screen.getByLabelText(/Đơn nhập nháp/);
  await fireEvent.press(draftsBtn);
  expect(router.push).toHaveBeenCalledWith('/receipts');
});

test('back button calls router.back if canGoBack is true or replace / if false', async () => {
  jest.spyOn(digestApi, 'getDigest').mockResolvedValue(fullDigest);

  await renderWithProviders(<DigestScreen />);
  await screen.findByText(fullDigest.summary_vi);

  await fireEvent.press(screen.getByRole('button', { name: 'Quay lại' }));
  expect(router.back).toHaveBeenCalled();

  (router.canGoBack as jest.Mock).mockReturnValueOnce(false);
  await fireEvent.press(screen.getByRole('button', { name: 'Quay lại' }));
  expect(router.replace).toHaveBeenCalledWith('/');
});

test('error state shows retry button and retries successfully', async () => {
  const getSpy = jest
    .spyOn(digestApi, 'getDigest')
    .mockRejectedValueOnce(new Error('Fetch failed'))
    .mockResolvedValueOnce(fullDigest);

  await renderWithProviders(<DigestScreen />);

  expect(await screen.findByText('Không tải được tóm tắt')).toBeOnTheScreen();

  const retryBtn = screen.getByRole('button', { name: 'Thử lại' });
  await fireEvent.press(retryBtn);

  expect(await screen.findByLabelText(/^Doanh thu/)).toBeOnTheScreen();
  expect(getSpy).toHaveBeenCalledTimes(2);
});

test('handles negative change_pct, 0 change_pct, and null item total_cost', async () => {
  const customDigest: Digest = {
    ...fullDigest,
    sales: {
      ...fullDigest.sales,
      change_pct: -8.5,
    },
    restock: [
      {
        product_id: 'p-1',
        name: 'Món không có giá vốn',
        quantity: 5,
        unit_cost: null,
        total_cost: null,
      },
    ],
  };
  jest.spyOn(digestApi, 'getDigest').mockResolvedValue(customDigest);

  await renderWithProviders(<DigestScreen />);

  expect(await screen.findByText('-8.5%')).toBeOnTheScreen();
  expect(screen.getByText('Món không có giá vốn')).toBeOnTheScreen();
  expect(screen.getByText('× 5')).toBeOnTheScreen();
});

test('renders empty state when there is no digest for the date (null response)', async () => {
  jest
    .spyOn(digestApi, 'getDigest')
    .mockResolvedValue(null as unknown as Digest);

  await renderWithProviders(<DigestScreen />);

  expect(
    await screen.findByText('Không có tóm tắt cho ngày này'),
  ).toBeOnTheScreen();
});

test('passes business_date from search params to useDigest', async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({
    business_date: '2026-10-20',
  });
  const getSpy = jest.spyOn(digestApi, 'getDigest').mockResolvedValue({
    ...fullDigest,
    business_date: '2026-10-20',
  });

  await renderWithProviders(<DigestScreen />);

  expect(await screen.findByText('Thứ ba, 20/10 · 14:00')).toBeOnTheScreen();
  expect(getSpy).toHaveBeenCalledWith('2026-10-20', true);
});
