import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Dimensions } from 'react-native';

import * as productsApi from '@/lib/api/products';
import { keys } from '@/lib/api/keys';
import type { ProductWithStock } from '@/lib/api/types';
import { PRODUCT_IDS, resetMockDb } from '@/lib/mock';
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

test('shows name, price, stock, cost and a derived description', async () => {
  await renderProduct();
  expect(
    await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' }),
  ).toBeOnTheScreen();
  expect(screen.getByText('10.000đ')).toBeOnTheScreen();
  expect(screen.getByLabelText('Tồn kho 48')).toBeOnTheScreen();
  expect(screen.getByLabelText('Giá nhập 7.500đ')).toBeOnTheScreen();
  expect(
    screen.getByText('Nước giải khát. 1 thùng = 24 lon, 230.000đ.'),
  ).toBeOnTheScreen();
  expect(flat(screen.getByLabelText('Tồn kho 48'))).toMatchObject({
    backgroundColor: colors.surfaceSoft,
    borderRadius: radius.lg,
  });
});

test('hides missing stock, cost and description', async () => {
  const product = (await productsApi.getProduct(
    PRODUCT_IDS.coca,
  )) as ProductWithStock;
  jest.spyOn(productsApi, 'getProduct').mockResolvedValue({
    ...product,
    stock_quantity: undefined,
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
  expect(screen.queryByLabelText(/Tồn kho/)).toBeNull();
  expect(screen.queryByLabelText(/Giá nhập/)).toBeNull();
  expect(screen.queryByTestId('product-description')).toBeNull();
  expect(screen.getByTestId('product-photo-empty')).toBeOnTheScreen();
  expect(screen.queryByLabelText(/Ảnh \d trên/)).toBeNull();
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
    queryClient.getQueryData<ProductWithStock>(
      keys.products.detail(PRODUCT_IDS.coca),
    )?.price,
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
      .getQueryData<{ pages: { items: ProductWithStock[] }[] }>(
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
