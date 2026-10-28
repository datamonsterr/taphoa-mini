import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Dimensions } from 'react-native';

import { ApiError } from '@/lib/api/errors';
import * as productsApi from '@/lib/api/products';
import * as stockApi from '@/lib/api/stock';
import { keys } from '@/lib/api/keys';
import type { Product } from '@/lib/api/types';
import { testSession, setTestMembership } from '@/test/session';
import { useSettingsStore } from '@/stores/settings';
import { PRODUCT_IDS, resetMockDb } from '@/test/mock';
import { holdNext } from '@/test/hold';
import { createTestQueryClient, renderWithProviders } from '@/test/render';
import { colors, radius } from '@/theme';

import { ProductScreen } from './ProductScreen';

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: jest.fn(() => true),
  },
  useLocalSearchParams: jest.fn(),
}));

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

const setId = (id: string) =>
  jest.mocked(useLocalSearchParams).mockReturnValue({ id });

const renderProduct = (id: string = PRODUCT_IDS.coca, qc?: QueryClient) => {
  setId(id);
  return renderWithProviders(<ProductScreen />, qc);
};

const pressKeys = async (...keysToPress: string[]) => {
  for (const key of keysToPress) {
    await fireEvent.press(screen.getByRole('button', { name: key }));
  }
};

beforeEach(() => {
  resetMockDb();
  jest.clearAllMocks();
  jest.mocked(router.canGoBack).mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());

test('shows a skeleton while loading', async () => {
  const release = holdNext(productsApi, 'getProduct');
  await renderProduct();
  expect(screen.getByTestId('product-skeleton')).toBeOnTheScreen();
  release();
  await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' });
  expect(screen.queryByTestId('product-skeleton')).toBeNull();
});

test('shows name, price, cost and a derived description', async () => {
  await renderProduct();
  expect(
    await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' }),
  ).toBeOnTheScreen();
  expect(screen.getByText('10.000đ')).toBeOnTheScreen();
  expect(screen.getByLabelText('Giá nhập 7.500đ')).toBeOnTheScreen();
  expect(
    screen.getByText('Nước giải khát. 1 thùng = 24 lon, 230.000đ.'),
  ).toBeOnTheScreen();
  expect(flat(screen.getByLabelText('Giá nhập 7.500đ'))).toMatchObject({
    backgroundColor: colors.surfaceSoft,
    borderRadius: radius.lg,
  });
});

test('hides missing cost and description', async () => {
  const product = (await productsApi.getProduct(PRODUCT_IDS.coca)) as Product;
  jest.spyOn(productsApi, 'getProduct').mockResolvedValue({
    ...product,
    cost_price: null,
    category_id: null,
    units: [],
    images: [],
    name: null,
  });
  await renderProduct();
  expect(
    await screen.findByRole('header', { name: 'Sản phẩm chưa đặt tên' }),
  ).toBeOnTheScreen();
  expect(screen.queryByLabelText(/Giá nhập/)).toBeNull();
  expect(screen.queryByTestId('product-description')).toBeNull();
  expect(screen.getByTestId('product-photo-empty')).toBeOnTheScreen();
  expect(screen.queryByLabelText(/Ảnh \d trên/)).toBeNull();
});

test('a Seller cannot edit the price: no edit button (the server would answer 403)', async () => {
  const session = testSession();
  setTestMembership({
    ...session!,
    member: { ...session!.member, role: 'seller' },
  });
  await renderProduct();
  await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' });
  expect(screen.queryByRole('button', { name: 'Sửa giá' })).toBeNull();
});

test('photo carousel dots follow the page', async () => {
  await renderProduct();
  const carousel = await screen.findByTestId('product-carousel');
  expect(screen.getByLabelText('Ảnh 1 trên 2')).toBeOnTheScreen();
  expect(screen.getAllByTestId('product-photo')).toHaveLength(2);
  const width = Dimensions.get('window').width - 32;
  await fireEvent.scroll(carousel, {
    nativeEvent: {
      contentOffset: { x: width, y: 0 },
      contentSize: { width: width * 2, height: 300 },
      layoutMeasurement: { width, height: 300 },
    },
  });
  expect(screen.getByLabelText('Ảnh 2 trên 2')).toBeOnTheScreen();
  expect(flat(screen.getByTestId('dot-1'))).toMatchObject({ width: 20 });
  expect(flat(screen.getByTestId('dot-0'))).toMatchObject({ width: 6 });
});

test('photo carousel is as wide as its well so it scrolls instead of growing', async () => {
  await renderProduct();
  const carousel = await screen.findByTestId('product-carousel');
  expect(flat(carousel)).toMatchObject({ width: '100%' });
});

test('single photo shows no dots', async () => {
  await renderProduct(PRODUCT_IDS.pepsi);
  await screen.findByRole('header', { name: 'Pepsi lon 330ml' });
  expect(screen.queryByLabelText(/Ảnh \d trên/)).toBeNull();
});

test('back goes back, or to the inventory when there is no history', async () => {
  await renderProduct();
  await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' });
  await fireEvent.press(screen.getByRole('button', { name: 'Quay lại' }));
  expect(router.back).toHaveBeenCalledTimes(1);

  jest.mocked(router.canGoBack).mockReturnValue(false);
  await fireEvent.press(screen.getByRole('button', { name: 'Quay lại' }));
  expect(router.replace).toHaveBeenCalledWith('/inventory');
});

test('edit opens the keypad sheet on the current price; scrim closes it', async () => {
  await renderProduct();
  await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' });
  expect(screen.queryByTestId('edit-price-display')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Sửa giá' }));
  expect(screen.getByTestId('edit-price-display')).toHaveTextContent('10.000đ');
  await fireEvent.press(screen.getByTestId('sheet-scrim'));
  expect(screen.queryByTestId('edit-price-display')).toBeNull();
});

test('keypad edits the price and the check saves it optimistically', async () => {
  const spy = jest.spyOn(productsApi, 'patchProduct');
  await renderProduct();
  await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' });
  await fireEvent.press(screen.getByRole('button', { name: 'Sửa giá' }));
  await pressKeys('Xóa', 'Xóa', 'Xóa', 'Xóa', 'Xóa');
  expect(screen.getByTestId('edit-price-display')).toHaveTextContent('0đ');
  expect(screen.getByRole('button', { name: 'Lưu giá' })).toBeDisabled();
  await pressKeys('1', '2', '000');
  expect(screen.getByTestId('edit-price-display')).toHaveTextContent('12.000đ');

  await fireEvent.press(screen.getByRole('button', { name: 'Lưu giá' }));
  expect(screen.queryByTestId('edit-price-display')).toBeNull();
  expect(screen.getByText('12.000đ')).toBeOnTheScreen();
  await waitFor(() =>
    expect(spy).toHaveBeenCalledWith(PRODUCT_IDS.coca, { price: 12000 }),
  );
  await waitFor(async () =>
    expect((await productsApi.getProduct(PRODUCT_IDS.coca)).price).toBe(12000),
  );
  expect(screen.getByText('12.000đ')).toBeOnTheScreen();
});

test('saving an unchanged price does not call the API', async () => {
  const spy = jest.spyOn(productsApi, 'patchProduct');
  await renderProduct();
  await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' });
  await fireEvent.press(screen.getByRole('button', { name: 'Sửa giá' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu giá' }));
  expect(screen.queryByTestId('edit-price-display')).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});

test('a failed save rolls the price back and says so', async () => {
  jest.spyOn(productsApi, 'patchProduct').mockRejectedValue(new Error('boom'));
  const queryClient = createTestQueryClient();
  await renderProduct(PRODUCT_IDS.coca, queryClient);
  await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' });
  await fireEvent.press(screen.getByRole('button', { name: 'Sửa giá' }));
  await pressKeys('Xóa', '5');
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu giá' }));
  expect(
    await screen.findByText('Không lưu được giá. Đã khôi phục giá cũ.'),
  ).toBeOnTheScreen();
  expect(screen.getByText('10.000đ')).toBeOnTheScreen();
  expect(
    queryClient.getQueryData<Product>(keys.products.detail(PRODUCT_IDS.coca))
      ?.price,
  ).toBe(10000);
});

test('the optimistic price also reaches cached product lists, and rolls back', async () => {
  const queryClient = createTestQueryClient();
  const page = await productsApi.listProducts({ limit: 20 });
  queryClient.setQueryData(keys.products.list({ limit: 20 }), {
    pages: [page],
    pageParams: [null],
  });
  let rejectPatch: (error: Error) => void = () => undefined;
  jest.spyOn(productsApi, 'patchProduct').mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectPatch = reject;
    }),
  );
  await renderProduct(PRODUCT_IDS.coca, queryClient);
  await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' });
  await fireEvent.press(screen.getByRole('button', { name: 'Sửa giá' }));
  await pressKeys('Xóa', '5');
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu giá' }));

  const listPrice = () =>
    queryClient
      .getQueryData<{ pages: { items: Product[] }[] }>(
        keys.products.list({ limit: 20 }),
      )
      ?.pages[0]?.items.find((p) => p.id === PRODUCT_IDS.coca)?.price;
  await waitFor(() => expect(listPrice()).toBe(10005));
  await act(async () => rejectPatch(new Error('boom')));
  await waitFor(() => expect(listPrice()).toBe(10000));
});

test('unknown product shows not found with a working back', async () => {
  await renderProduct('00000000-0000-4000-8000-00000000dead');
  expect(await screen.findByText('Không tìm thấy sản phẩm')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Sửa giá' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Quay lại' }));
  expect(router.back).toHaveBeenCalled();
});

test('a load error offers retry', async () => {
  jest
    .spyOn(productsApi, 'getProduct')
    .mockRejectedValueOnce(new Error('boom'));
  await renderProduct();
  expect(await screen.findByText('Không tải được sản phẩm')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  expect(
    await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' }),
  ).toBeOnTheScreen();
});

test('tracked stock shows quantity, effective store threshold and status', async () => {
  await renderProduct();
  expect(
    await screen.findByLabelText('Tồn kho 20, Còn hàng'),
  ).toBeOnTheScreen();
  expect(await screen.findByText('Ngưỡng sắp hết: 5')).toBeOnTheScreen();
});

test('untracked products explain stock tracking and can start with a count', async () => {
  await renderProduct(PRODUCT_IDS['7up']);
  expect(await screen.findByText('Chưa theo dõi tồn kho')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Kiểm kho' })).toBeOnTheScreen();
});

describe('stock adjustments', () => {
  const openAdjust = async () => {
    await renderProduct();
    await fireEvent.press(
      await screen.findByRole('button', { name: 'Kiểm kho' }),
    );
  };

  test('a count with an optional note posts and updates stock', async () => {
    const adjust = jest.spyOn(stockApi, 'adjustStock');
    await openAdjust();
    await fireEvent.changeText(screen.getByLabelText('Số lượng thực tế'), '8');
    await fireEvent.changeText(
      screen.getByLabelText('Ghi chú (không bắt buộc)'),
      'Đếm lại',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu tồn kho' }));
    await waitFor(() =>
      expect(adjust).toHaveBeenCalledWith(
        PRODUCT_IDS.coca,
        { count: 8, note: 'Đếm lại' },
        expect.any(String),
      ),
    );
    expect(
      await screen.findByLabelText('Tồn kho 8, Còn hàng'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Số lượng thực tế')).toBeNull();
  });

  test.each(['+4', '-3'])('signed delta %s posts only delta', async (delta) => {
    const adjust = jest.spyOn(stockApi, 'adjustStock');
    await openAdjust();
    await fireEvent.press(screen.getByRole('radio', { name: 'Thêm / bớt' }));
    await fireEvent.changeText(
      screen.getByLabelText('Thay đổi số lượng (+/-)'),
      delta,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu tồn kho' }));
    await waitFor(() =>
      expect(adjust).toHaveBeenCalledWith(
        PRODUCT_IDS.coca,
        { delta: Number(delta) },
        expect.any(String),
      ),
    );
  });

  test('invalid counts and zero deltas cannot be submitted', async () => {
    const adjust = jest.spyOn(stockApi, 'adjustStock');
    await openAdjust();
    for (const value of ['', '-1', '1.2', '999999999999']) {
      await fireEvent.changeText(
        screen.getByLabelText('Số lượng thực tế'),
        value,
      );
      expect(
        screen.getByRole('button', { name: 'Lưu tồn kho' }),
      ).toBeDisabled();
    }
    await fireEvent.press(screen.getByRole('radio', { name: 'Thêm / bớt' }));
    await fireEvent.changeText(
      screen.getByLabelText('Thay đổi số lượng (+/-)'),
      '0',
    );
    expect(screen.getByRole('button', { name: 'Lưu tồn kho' })).toBeDisabled();
    expect(adjust).not.toHaveBeenCalled();
  });

  test('failure preserves the draft and retries with the same operation key', async () => {
    const adjust = jest
      .spyOn(stockApi, 'adjustStock')
      .mockRejectedValueOnce(new Error('offline'));
    await openAdjust();
    await fireEvent.changeText(screen.getByLabelText('Số lượng thực tế'), '9');
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu tồn kho' }));
    expect(
      await screen.findByText('Không lưu được tồn kho. Thử lại.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Số lượng thực tế').props.value).toBe('9');
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu tồn kho' }));
    await waitFor(() => expect(adjust).toHaveBeenCalledTimes(2));
    expect(adjust.mock.calls[0][2]).toBe(adjust.mock.calls[1][2]);
    await waitFor(() =>
      expect(screen.queryByLabelText('Số lượng thực tế')).toBeNull(),
    );
  });

  test('seller has no adjust button or threshold editor', async () => {
    const session = testSession();
    setTestMembership({
      ...session!,
      member: { ...session!.member, role: 'seller' },
    });
    await renderProduct();
    await screen.findByLabelText('Tồn kho 20, Còn hàng');
    expect(screen.queryByRole('button', { name: 'Kiểm kho' })).toBeNull();
    expect(
      screen.queryByLabelText('Ngưỡng riêng (để trống dùng mặc định)'),
    ).toBeNull();
  });
});

describe('stock movements', () => {
  test('recent movements show localized reasons, signed deltas, resulting counts and dates', async () => {
    jest.spyOn(stockApi, 'listStockMovements').mockResolvedValue({
      items: [
        {
          id: 'receipt',
          reason: 'receipt',
          delta: 12,
          quantity_after: 20,
          created_at: '2026-10-25T05:30:00Z',
          note: null,
          member_id: null,
          ref_id: null,
        },
        {
          id: 'sale',
          reason: 'sale',
          delta: -2,
          quantity_after: 8,
          created_at: '2026-10-24T05:30:00Z',
          note: null,
          member_id: null,
          ref_id: null,
        },
        {
          id: 'void',
          reason: 'sale_void',
          delta: 2,
          quantity_after: 10,
          created_at: '2026-10-23T05:30:00Z',
          note: null,
          member_id: null,
          ref_id: null,
        },
        {
          id: 'adjust',
          reason: 'adjustment',
          delta: -1,
          quantity_after: 9,
          created_at: '2026-10-22T05:30:00Z',
          note: 'Kiểm lại',
          member_id: null,
          ref_id: null,
        },
      ],
      next_cursor: null,
    });
    await renderProduct();
    expect(await screen.findByText('Biến động gần đây')).toBeOnTheScreen();
    // The heading renders before the movement query resolves; wait for the first row.
    expect((await screen.findAllByText('Nhập hàng')).length).toBeGreaterThan(0);
    for (const reason of ['Bán hàng', 'Hủy bán', 'Kiểm kho']) {
      expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('+12')).toBeOnTheScreen();
    expect(screen.getByText('-2')).toBeOnTheScreen();
    expect(screen.getByText('Còn lại: 20')).toBeOnTheScreen();
    expect(screen.getByText(/25\/10\/2026/)).toBeOnTheScreen();
    expect(screen.getByText('Kiểm lại')).toBeOnTheScreen();
    await act(async () => useSettingsStore.setState({ language: 'en' }));
    for (const reason of ['Receipt', 'Sale', 'Sale void', 'Adjustment'])
      expect(screen.getByText(reason)).toBeOnTheScreen();
  });

  test('empty movements explain there is no history', async () => {
    await renderProduct();
    expect(
      await screen.findByText('Chưa có biến động tồn kho'),
    ).toBeOnTheScreen();
  });

  test('movement load failure offers its own retry', async () => {
    jest
      .spyOn(stockApi, 'listStockMovements')
      .mockRejectedValueOnce(new Error('offline'));
    await renderProduct();
    expect(
      await screen.findByText('Không tải được biến động tồn kho'),
    ).toBeOnTheScreen();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Tải lại biến động' }),
    );
    expect(
      await screen.findByText('Chưa có biến động tồn kho'),
    ).toBeOnTheScreen();
  });
});

describe('product threshold override', () => {
  const fieldLabel = 'Ngưỡng riêng (để trống dùng mặc định)';
  test('Lead overrides the store threshold and empty resets to the store default', async () => {
    const patch = jest.spyOn(productsApi, 'patchProduct');
    await renderProduct();
    const field = await screen.findByLabelText(fieldLabel);
    expect(field.props.value).toBe('');
    await fireEvent.changeText(field, '25');
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu ngưỡng' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(PRODUCT_IDS.coca, {
        low_stock_threshold: 25,
      }),
    );
    expect(await screen.findByText('Ngưỡng sắp hết: 25')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText(fieldLabel), '');
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu ngưỡng' }));
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith(PRODUCT_IDS.coca, {
        low_stock_threshold: null,
      }),
    );
    expect(await screen.findByText('Ngưỡng sắp hết: 5')).toBeOnTheScreen();
  });

  test('override validates integer range 0..100000 and preserves failed draft', async () => {
    jest
      .spyOn(productsApi, 'patchProduct')
      .mockRejectedValueOnce(new Error('offline'));
    await renderProduct();
    await screen.findByLabelText(fieldLabel);
    for (const value of ['-1', '1.2', '100001']) {
      await fireEvent.changeText(screen.getByLabelText(fieldLabel), value);
      expect(screen.getByRole('button', { name: 'Lưu ngưỡng' })).toBeDisabled();
    }
    await fireEvent.changeText(screen.getByLabelText(fieldLabel), '0');
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu ngưỡng' }));
    expect(
      await screen.findByText('Không lưu được ngưỡng sắp hết'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText(fieldLabel).props.value).toBe('0');
    await fireEvent.press(screen.getByRole('button', { name: 'Lưu ngưỡng' }));
    expect(await screen.findByText('Ngưỡng sắp hết: 0')).toBeOnTheScreen();
  });
});

test('product edit saves and clears the base barcode without changing price', async () => {
  const patch = jest.spyOn(productsApi, 'patchProduct');
  await renderProduct();
  await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' });
  await fireEvent.press(screen.getByLabelText('Sửa giá'));
  await fireEvent.changeText(
    screen.getByLabelText('Mã vạch (không bắt buộc)'),
    '4006381333931',
  );
  await fireEvent.press(screen.getByLabelText('Lưu giá'));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith(PRODUCT_IDS.coca, {
      barcode: '4006381333931',
    }),
  );
  await screen.findByText('Mã vạch · 4006381333931');
  await fireEvent.press(screen.getByLabelText('Sửa giá'));
  expect(screen.getByLabelText('Mã vạch (không bắt buộc)')).toHaveDisplayValue(
    '4006381333931',
  );
  await fireEvent.changeText(
    screen.getByLabelText('Mã vạch (không bắt buộc)'),
    '',
  );
  await fireEvent.press(screen.getByLabelText('Lưu giá'));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith(PRODUCT_IDS.coca, { barcode: null }),
  );
});

test('product edit preserves a duplicate code and allows correction after 409', async () => {
  await productsApi.patchProduct(PRODUCT_IDS.pepsi, {
    barcode: '4006381333931',
  });
  const patch = jest
    .spyOn(productsApi, 'patchProduct')
    .mockRejectedValueOnce(
      new ApiError(409, { error: 'barcode already used', code: 'conflict' }),
    );
  await renderProduct();
  await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' });
  await fireEvent.press(screen.getByLabelText('Sửa giá'));
  await fireEvent.changeText(
    screen.getByLabelText('Mã vạch (không bắt buộc)'),
    '4006381333931',
  );
  await fireEvent.press(screen.getByLabelText('Lưu giá'));
  await screen.findByText('Mã vạch đã dùng cho Pepsi lon 330ml');
  expect(screen.getByLabelText('Mã vạch (không bắt buộc)')).toHaveDisplayValue(
    '4006381333931',
  );
  await fireEvent.changeText(
    screen.getByLabelText('Mã vạch (không bắt buộc)'),
    '12345678',
  );
  await fireEvent.press(screen.getByLabelText('Lưu giá'));
  await waitFor(() =>
    expect(patch).toHaveBeenLastCalledWith(PRODUCT_IDS.coca, {
      barcode: '12345678',
    }),
  );
});
