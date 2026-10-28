import { seedCustomer } from '@/test/debts';
import { createCustomer } from '@/lib/api/debts';
/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories require lazily */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';

import * as storeApi from '@/lib/api/store';
import { holdNext } from '@/test/hold';
import { listSales, setApiTransport } from '@/lib/api';
import { createMockFetch } from '@/test/mock/fetch';
import { onlineManager } from '@tanstack/react-query';
import { flushOutbox, pendingItems } from '@/lib/outbox';
import * as ledgerApi from '@/lib/api/ledger';
import { getProduct } from '@/lib/api/products';
import { resetMockDb } from '@/test/mock/db';
import { PRODUCT_IDS } from '@/test/mock/fixtures';
import { useCartStore } from '@/stores/cart';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';

import type { CreateSaleRequest } from '@/lib/api';
import { newUuid, saleCode } from '@/lib/uuid';

import { PayScreen, SUCCESS_MS } from './PayScreen';
import { buildVietQr } from './vietqr';

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
  dismissAll: jest.fn(),
  canDismiss: jest.fn(() => true),
};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-qrcode-svg', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ value }: { value: string }) => (
      <Text testID="qr-value">{value}</Text>
    ),
  };
});

const sting = { productId: 'p-sting', name: 'Sting đỏ', price: 10000 };
const noodle = { productId: 'p-noodle', name: 'Hảo Hảo', price: 4500 };

function seed() {
  const { add } = useCartStore.getState();
  add({ ...sting, productId: PRODUCT_IDS.coca });
  add({ ...sting, productId: PRODUCT_IDS.coca });
  add({ ...noodle, manual: true, productId: PRODUCT_IDS.pepsi });
}

beforeEach(() => {
  onlineManager.setOnline(true);
  jest.clearAllMocks();
  jest.restoreAllMocks();
  mockRouter.canDismiss.mockReturnValue(true);
  resetMockDb();
  useCartStore.setState({ lines: [] });
  seed();
});

async function findNewSale() {
  const { items } = await listSales({ limit: 200 });
  const sale = items.find((s) =>
    s.lines.some((l) => l.manual_label === 'Hảo Hảo'),
  );
  if (!sale) throw new Error('sale not found');
  return sale;
}

describe('PayScreen transfer', () => {
  it('shows the total and the VietQR for the store bank account', async () => {
    await renderWithProviders(<PayScreen />);
    expect(
      screen.getByRole('header', { name: 'Thanh toán' }),
    ).toBeOnTheScreen();
    expect(screen.getByText('24.500đ')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Mã VietQR 24.500đ')).toBeOnTheScreen();
    const value = screen.getByTestId('qr-value').props.children as string;
    expect(value).toMatch(/^000201010212/);
    expect(value).toContain('0010A000000727');
    expect(value).toContain('0006970436');
    expect(value).toContain('540524500');
    expect(value).toMatch(/6304[0-9A-F]{4}$/);
    expect(value).toBe(
      buildVietQr({
        bankBin: '970436',
        accountNumber: '0123456789',
        amount: 24500,
        memo: value.match(/0809(TH [0-9A-Z]{6})/)![1],
      }),
    );
  });

  it('shows one bank line and reads the holder aloud', async () => {
    await renderWithProviders(<PayScreen />);
    expect(await screen.findByText('VCB · 0123 456 789')).toBeOnTheScreen();
    // The board shows one bank line; the holder is only in the accessibility label.
    expect(screen.queryByText('NGUYEN THI BA')).not.toBeOnTheScreen();
    expect(
      screen.getByLabelText('NGUYEN THI BA, VCB 0123 456 789'),
    ).toBeOnTheScreen();
  });

  it('shows line thumbnails with quantity badge and line total', async () => {
    await renderWithProviders(<PayScreen />);
    expect(screen.getByLabelText('Món trong đơn')).toBeOnTheScreen();
    expect(screen.getByText('20.000')).toBeOnTheScreen();
    expect(screen.getByText('4.500')).toBeOnTheScreen();
    expect(screen.getByText('2')).toBeOnTheScreen();
  });

  it('shows an error with retry when the store cannot load', async () => {
    jest.spyOn(storeApi, 'getStore').mockRejectedValueOnce(new Error('down'));
    await renderWithProviders(<PayScreen />);
    expect(
      await screen.findByText('Không tải được tài khoản ngân hàng'),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText('Thử lại'));
    expect(await screen.findByLabelText('Mã VietQR 24.500đ')).toBeOnTheScreen();
  });

  it('shows a hint when the store has no bank account', async () => {
    const real = await storeApi.getStore();
    jest
      .spyOn(storeApi, 'getStore')
      .mockResolvedValue({ ...real, bank_account: undefined });
    await renderWithProviders(<PayScreen />);
    expect(
      await screen.findByText('Chưa có tài khoản ngân hàng'),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('qr-value')).toBeNull();
  });

  it('offers a way out: a button to the account tab, and cash still works', async () => {
    const real = await storeApi.getStore();
    jest
      .spyOn(storeApi, 'getStore')
      .mockResolvedValue({ ...real, bank_account: undefined });
    await renderWithProviders(<PayScreen />);
    await fireEvent.press(
      await screen.findByRole('button', { name: 'Thêm tài khoản ngân hàng' }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith('/account');
    await fireEvent.press(screen.getByRole('radio', { name: 'Tiền mặt' }));
    expect(screen.getByRole('button', { name: 'Đã nhận tiền' })).toBeEnabled();
  });

  it('shows a loading indicator while the store loads', async () => {
    const release = holdNext(storeApi, 'getStore');
    await renderWithProviders(<PayScreen />);
    expect(screen.getByLabelText('Đang tải')).toBeOnTheScreen();
    release();
    await screen.findByTestId('qr-value');
  });

  it('goes back to the cart', async () => {
    await renderWithProviders(<PayScreen />);
    await fireEvent.press(screen.getByLabelText('Quay lại giỏ hàng'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});

describe('PayScreen cash', () => {
  async function openCash() {
    await renderWithProviders(<PayScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Tiền mặt' }));
  }

  it('lists exact amount and notes, no QR', async () => {
    await openCash();
    expect(screen.queryByTestId('qr-value')).toBeNull();
    expect(screen.getByRole('button', { name: 'Đủ tiền' })).toBeOnTheScreen();
    for (const label of ['50.000', '100.000', '200.000', '500.000']) {
      expect(screen.getByText(label)).toBeOnTheScreen();
    }
    expect(screen.getByLabelText('Tiền thối')).toHaveTextContent('0đ');
  });

  it('computes change for a picked note', async () => {
    await openCash();
    await fireEvent.press(screen.getByText('100.000'));
    expect(screen.getByLabelText('Tiền thối')).toHaveTextContent('75.500đ');
    expect(screen.getByText('100.000')).toBeOnTheScreen();
  });

  it('switches back to transfer', async () => {
    await openCash();
    await fireEvent.press(screen.getByRole('radio', { name: 'Chuyển khoản' }));
    expect(await screen.findByTestId('qr-value')).toBeOnTheScreen();
  });

  it('blocks received while the given note is short', async () => {
    useCartStore
      .getState()
      .add({ ...sting, productId: 'p-extra', price: 40000 });
    await openCash();
    await fireEvent.press(screen.getByText('50.000'));
    expect(screen.getByRole('button', { name: 'Đã nhận tiền' })).toBeDisabled();
    await fireEvent.press(screen.getByText('100.000'));
    expect(screen.getByRole('button', { name: 'Đã nhận tiền' })).toBeEnabled();
  });
});

describe('PayScreen received', () => {
  it('creates a transfer sale, clears the cart and returns to the camera', async () => {
    await renderWithProviders(<PayScreen />);
    await screen.findByTestId('qr-value');
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    await waitFor(() => expect(useCartStore.getState().lines).toEqual([]));
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
    const sale = await findNewSale();
    expect(sale.payment_method).toBe('transfer');
    expect(sale.total).toBe(24500);
    expect(sale.lines.map((l) => l.source).sort()).toEqual([
      'camera',
      'manual',
    ]);
    expect(await screen.findByLabelText('Đã nhận tiền xong')).toBeOnTheScreen();
    await waitFor(() => expect(mockRouter.dismissAll).toHaveBeenCalled(), {
      timeout: SUCCESS_MS + 2000,
    });
  });

  it('creates a cash sale with the cash received', async () => {
    await renderWithProviders(<PayScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Tiền mặt' }));
    await fireEvent.press(screen.getByText('50.000'));
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    await waitFor(() => expect(useCartStore.getState().lines).toEqual([]));
    const sale = await findNewSale();
    expect(sale.payment_method).toBe('cash');
    expect(sale.cash_received).toBe(50000);
  });

  it('replaces to the root when there is no stack to dismiss', async () => {
    mockRouter.canDismiss.mockReturnValue(false);
    await renderWithProviders(<PayScreen />);
    await screen.findByTestId('qr-value');
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'), {
      timeout: SUCCESS_MS + 2000,
    });
  });

  it('records the sale on the device and finishes even when the server fails', async () => {
    jest
      .spyOn(ledgerApi, 'createSale')
      .mockRejectedValue(new TypeError('Network request failed'));
    await renderWithProviders(<PayScreen />);
    await screen.findByTestId('qr-value');
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    expect(await screen.findByLabelText('Đã nhận tiền xong')).toBeOnTheScreen();
    expect(useCartStore.getState().lines).toEqual([]);
    await waitFor(() => expect(pendingItems('sale')).toHaveLength(1));
  });

  it('offline: no request is made, the sale waits in the outbox and posts once on reconnect', async () => {
    const create = jest.spyOn(ledgerApi, 'createSale');
    await renderWithProviders(<PayScreen />);
    await screen.findByTestId('qr-value');
    await act(async () => onlineManager.setOnline(false));
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    expect(await screen.findByLabelText('Đã nhận tiền xong')).toBeOnTheScreen();
    expect(create).not.toHaveBeenCalled();
    const [queued] = pendingItems('sale');
    onlineManager.setOnline(true);
    await flushOutbox();
    expect(create).toHaveBeenCalledTimes(1);
    expect(pendingItems()).toEqual([]);
    const { items } = await listSales({ limit: 200 });
    expect(items.filter((s) => s.id === queued!.key)).toHaveLength(1);
  });

  it('puts the sale id in the Idempotency-Key header and its code in the memo', async () => {
    const seen: Request[] = [];
    const mock = createMockFetch();
    setApiTransport(((input: Request) => {
      seen.push(input.clone());
      return mock(input);
    }) as typeof fetch);
    await renderWithProviders(<PayScreen />);
    const qr = (await screen.findByTestId('qr-value')).props.children as string;
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    await waitFor(() => expect(useCartStore.getState().lines).toEqual([]));
    const post = seen.find(
      (request) =>
        request.method === 'POST' && request.url.endsWith('/v1/sales'),
    )!;
    const body = (await post.json()) as CreateSaleRequest;
    expect(post.headers.get('idempotency-key')).toBe(body.id);
    expect(body.vietqr_memo).toBe(`TH ${saleCode(body.id)}`);
    expect(qr).toContain(`0809${body.vietqr_memo}`);
  });

  it('sends the camera source of a multi-photo line', async () => {
    useCartStore.setState({ lines: [] });
    useCartStore
      .getState()
      .add({ ...sting, productId: PRODUCT_IDS.coca, source: 'multi_photo' });
    const create = jest.spyOn(ledgerApi, 'createSale');
    await renderWithProviders(<PayScreen />);
    await screen.findByTestId('qr-value');
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0].lines[0]!.source).toBe('multi_photo');
  });

  it('disables received while the sale is pending', async () => {
    let release: (v: never) => void = () => {};
    jest
      .spyOn(ledgerApi, 'createSale')
      .mockReturnValueOnce(
        new Promise((resolve) => (release = resolve as never)),
      );
    await renderWithProviders(<PayScreen />);
    await screen.findByTestId('qr-value');
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Đã nhận tiền' }),
      ).toBeDisabled(),
    );
    release(undefined as never);
  });

  it('sends the scan labels: detection_id, suggested_product_id and scan_ids', async () => {
    const DET_A = '11111111-1111-4111-8111-111111111111';
    const SCAN_A = '22222222-2222-4222-8222-222222222222';
    useCartStore.setState({ lines: [] });
    useCartStore.getState().add({
      ...sting,
      productId: PRODUCT_IDS.coca,
      detectionId: DET_A,
      suggestedProductId: PRODUCT_IDS.pepsi,
      scanId: SCAN_A,
    });
    useCartStore.getState().add({
      ...noodle,
      manual: true,
      productId: PRODUCT_IDS.pepsi,
    });
    const create = jest.spyOn(ledgerApi, 'createSale');
    await renderWithProviders(<PayScreen />);
    await screen.findByTestId('qr-value');
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const body = create.mock.calls[0]![0];
    expect(body.scan_ids).toEqual([SCAN_A]);
    expect(body.lines[0]).toMatchObject({
      product_id: PRODUCT_IDS.coca,
      source: 'camera',
      detection_id: DET_A,
      suggested_product_id: PRODUCT_IDS.pepsi,
    });
    expect(body.lines[1]).not.toHaveProperty('detection_id');
    expect(body.lines[1]).not.toHaveProperty('suggested_product_id');
  });

  it('sends no scan_ids when no line came from a scan', async () => {
    const create = jest.spyOn(ledgerApi, 'createSale');
    await renderWithProviders(<PayScreen />);
    await screen.findByTestId('qr-value');
    await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).not.toHaveProperty('scan_ids');
  });

  it('cannot be pressed with an empty cart', async () => {
    useCartStore.setState({ lines: [] });
    await renderWithProviders(<PayScreen />);
    expect(screen.getByRole('button', { name: 'Đã nhận tiền' })).toBeDisabled();
  });
});

describe('PayScreen language', () => {
  it('names the pay toggle in English', async () => {
    useSettingsStore.setState({ language: 'en' });
    await renderWithProviders(<PayScreen />);
    expect(
      screen.getByRole('radio', { name: 'Bank transfer' }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Cash' })).toBeOnTheScreen();
  });
});

describe('PayScreen credit', () => {
  async function chooseCustomer(limit?: number) {
    const c = await createCustomer({
      id: newUuid(),
      name: 'Chị Lan',
      phone: '0901234567',
      ...(limit === undefined ? {} : { credit_limit: limit }),
    });
    await renderWithProviders(<PayScreen />);
    await fireEvent.press(screen.getByLabelText('Ghi nợ'));
    await fireEvent.press(await screen.findByLabelText('Chị Lan, 0đ'));
    return c;
  }
  it('sends full credit and preserves success behaviour', async () => {
    const c = await chooseCustomer();
    expect(screen.getByText('Ghi nợ 24.500đ')).toBeOnTheScreen();
    expect(screen.getAllByTestId('icon-BookOpen')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Ghi nợ 24.500đ' })).toHaveStyle({
      backgroundColor: '#111114',
    });
    expect(screen.getByText('0901234567')).toBeOnTheScreen();
    expect(screen.getByText('Đang nợ 0đ')).toBeOnTheScreen();
    expect(screen.getByText('Đổi')).toBeOnTheScreen();
    expect(screen.getByText('Nợ mới của khách 24.500đ')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: /^Ghi nợ / }));
    await screen.findByLabelText('Đã nhận tiền xong');
    expect(await findNewSale()).toMatchObject({
      payment_method: 'credit',
      customer_id: c.id,
      credit_amount: 24500,
      cash_received: null,
    });
  });
  it('sends partial cash with paid-now amount', async () => {
    await chooseCustomer();
    await fireEvent.press(screen.getByLabelText('Khác'));
    await fireEvent.changeText(screen.getByLabelText('Trả trước'), '10000');
    await fireEvent.press(screen.getByLabelText('Xong'));
    expect(
      screen.getByRole('button', { name: 'Ghi nợ 14.500đ' }),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: /^Ghi nợ / }));
    await screen.findByLabelText('Đã nhận tiền xong');
    expect(await findNewSale()).toMatchObject({
      payment_method: 'cash',
      credit_amount: 14500,
      cash_received: 10000,
      change_given: 0,
    });
  });
  it('warns over the limit and keeps confirm enabled', async () => {
    await chooseCustomer(1000);
    expect(screen.getByText('Vượt hạn mức ghi nợ')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^Ghi nợ / })).toBeEnabled();
  });
  it('blocks paid-now above total and treats exact payment as normal cash', async () => {
    await chooseCustomer();
    await fireEvent.press(screen.getByLabelText('Khác'));
    await fireEvent.changeText(screen.getByLabelText('Trả trước'), '24501');
    expect(screen.getByLabelText('Xong')).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Ghi nợ / })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Trả trước'), '24500');
    await fireEvent.press(screen.getByLabelText('Xong'));
    await fireEvent.press(screen.getByRole('button', { name: /^Ghi nợ / }));
    await screen.findByLabelText('Đã nhận tiền xong');
    expect(await findNewSale()).toMatchObject({
      payment_method: 'cash',
      credit_amount: 0,
      cash_received: 24500,
    });
  });

  it('quick prepayment chips update the projected debt and custom keypad amount', async () => {
    await chooseCustomer();
    await fireEvent.press(screen.getByRole('radio', { name: '20.000đ' }));
    expect(screen.getByText('Nợ mới của khách 4.500đ')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Ghi nợ 4.500đ' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('radio', { name: '0đ' }));
    await fireEvent.press(screen.getByLabelText('Khác'));
    for (const key of ['1', '0', '000'])
      await fireEvent.press(screen.getByRole('button', { name: key }));
    await fireEvent.press(screen.getByLabelText('Xong'));
    expect(
      screen.getByRole('button', { name: 'Ghi nợ 14.500đ' }),
    ).toBeEnabled();
  });

  it('adds the sale to the existing balance and lets the seller change customers', async () => {
    await seedCustomer({ name: 'Chị Lan', phone: '0901234567', owes: 100000 });
    await renderWithProviders(<PayScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Ghi nợ' }));
    await fireEvent.press(await screen.findByLabelText('Chị Lan, 100.000đ'));
    expect(screen.getByText('Đang nợ 100.000đ')).toBeOnTheScreen();
    expect(screen.getByText('Nợ mới của khách 124.500đ')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: '20.000đ' }));
    expect(screen.getByText('Nợ mới của khách 104.500đ')).toBeOnTheScreen();
    await fireEvent.press(
      screen.getByRole('button', { name: /Đổi khách hàng$/ }),
    );
    expect(
      screen.getByRole('header', { name: 'Chọn khách ghi nợ' }),
    ).toBeOnTheScreen();
  });
});

test('checkout sends chosen unit_id and its price, with separate base and pack lines', async () => {
  useCartStore.setState({ lines: [] });
  const product = await getProduct(PRODUCT_IDS.coca);
  const unit = product.units[0]!;
  useCartStore
    .getState()
    .add({ productId: product.id, name: product.name!, price: product.price });
  useCartStore.getState().add({
    productId: product.id,
    name: product.name!,
    price: unit.price,
    unitId: unit.id,
  });
  const request = jest.spyOn(ledgerApi, 'createSale');
  await renderWithProviders(<PayScreen />);
  await screen.findByTestId('qr-value');
  await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
  await waitFor(() => expect(request).toHaveBeenCalled());
  const body = request.mock.calls[0]![0];
  expect(body.lines).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        product_id: product.id,
        unit_price: product.price,
      }),
      expect.objectContaining({
        product_id: product.id,
        unit_id: unit.id,
        unit_price: unit.price,
      }),
    ]),
  );
  expect(new Set(body.lines.map((line) => line.id)).size).toBe(2);
  expect(body.total).toBe(product.price + unit.price);
});

describe('PayScreen spoken total', () => {
  afterEach(() => useSettingsStore.setState({ speakTotal: false }));

  it('is silent while the setting is off', async () => {
    await renderWithProviders(<PayScreen />);
    expect(Speech.speak).not.toHaveBeenCalled();
  });

  it('reads the total in Vietnamese when the sheet opens, and stops on unmount', async () => {
    useSettingsStore.setState({ speakTotal: true });
    const view = await renderWithProviders(<PayScreen />);
    expect(Speech.speak).toHaveBeenCalledTimes(1);
    expect(Speech.speak).toHaveBeenCalledWith(
      'Tổng cộng hai mươi bốn nghìn năm trăm đồng',
      { language: 'vi-VN' },
    );
    (Speech.stop as jest.Mock).mockClear();
    await view.unmount();
    expect(Speech.stop).toHaveBeenCalled();
  });

  it('reads the change when the cash given exceeds the total', async () => {
    useSettingsStore.setState({ speakTotal: true });
    await renderWithProviders(<PayScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Tiền mặt' }));
    expect(Speech.speak).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText('100.000'));
    // spoken only once the amount settles, not on every keypad press
    expect(Speech.speak).toHaveBeenCalledTimes(1);
    await waitFor(
      () =>
        expect(Speech.speak).toHaveBeenLastCalledWith(
          'Tiền thối bảy mươi lăm nghìn năm trăm đồng',
          { language: 'vi-VN' },
        ),
      { timeout: 2000 },
    );
  });
});
