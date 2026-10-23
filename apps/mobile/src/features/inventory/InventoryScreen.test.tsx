import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import { router } from 'expo-router';
import {
  fireGestureHandler,
  getByGestureTestId,
} from 'react-native-gesture-handler/jest-utils';

import * as productsApi from '@/lib/api/products';
import { holdNext } from '@/test/hold';
import { PRODUCT_IDS, resetMockDb } from '@/lib/mock';
import { renderWithProviders } from '@/test/render';

import { InventoryScreen, HANDLE_PAN_TEST_ID } from './InventoryScreen';

let mockParams: Record<string, string | undefined> = {};
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    dismissTo: jest.fn(),
    back: jest.fn(),
    setParams: jest.fn(),
  },
  useLocalSearchParams: () => mockParams,
}));

const mockTileRenders = jest.fn();
jest.mock('@/components/ui/ProductTile', () => {
  const actual = jest.requireActual('@/components/ui/ProductTile');
  return {
    ...actual,
    // A plain wrapper runs on every render of its parent tile, so it counts tile renders.
    ProductTile: (props: { name: string }) => {
      mockTileRenders(props.name);
      return <actual.ProductTile {...props} />;
    },
  };
});

beforeEach(() => {
  mockParams = {};
  resetMockDb();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const COCA = 'Coca-Cola lon 330ml, 10.000đ, còn 48';
const SEVEN_UP = '7Up lon 330ml, 9.000đ, sắp hết: còn 3';

test('shows the title, the search circle and a skeleton while loading', async () => {
  const release = holdNext(productsApi, 'listProducts');
  await renderWithProviders(<InventoryScreen />);
  expect(screen.getByRole('header', { name: 'Kho' })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Tìm' })).toBeOnTheScreen();
  expect(screen.getByTestId('inventory-skeleton')).toBeOnTheScreen();
  release();
  await screen.findByRole('button', { name: COCA });
  expect(screen.queryByTestId('inventory-skeleton')).toBeNull();
});

test('renders tiles with price and stock, low stock in amber', async () => {
  await renderWithProviders(<InventoryScreen />);
  expect(await screen.findByRole('button', { name: COCA })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: SEVEN_UP })).toBeOnTheScreen();
  expect(screen.getAllByTestId('icon-CircleAlert')).toHaveLength(3);
});

test('tile tap opens the product', async () => {
  await renderWithProviders(<InventoryScreen />);
  await fireEvent.press(await screen.findByRole('button', { name: COCA }));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/product/[id]',
    params: { id: PRODUCT_IDS.coca },
  });
});

test('handle tap returns to the camera', async () => {
  await renderWithProviders(<InventoryScreen />);
  await fireEvent.press(
    screen.getByRole('button', { name: 'Vuốt xuống: camera' }),
  );
  expect(router.dismissTo).toHaveBeenCalledWith('/');
});

test('handle pan down returns to the camera, a short pan does not', async () => {
  await renderWithProviders(<InventoryScreen />);
  fireGestureHandler(getByGestureTestId(HANDLE_PAN_TEST_ID), [
    { translationY: 10 },
    { translationY: 20, velocityY: 50 },
  ]);
  expect(router.dismissTo).not.toHaveBeenCalled();
  fireGestureHandler(getByGestureTestId(HANDLE_PAN_TEST_ID), [
    { translationY: 20 },
    { translationY: 200, velocityY: 100 },
  ]);
  expect(router.dismissTo).toHaveBeenCalledWith('/');
});

test('search expands, debounces 250 ms and filters the grid', async () => {
  jest.useFakeTimers();
  await renderWithProviders(<InventoryScreen />);
  await screen.findByRole('button', { name: COCA });
  const spy = jest.spyOn(productsApi, 'listProducts');

  await fireEvent.press(screen.getByRole('button', { name: 'Tìm' }));
  expect(screen.queryByRole('button', { name: 'Tìm' })).toBeNull();
  const field = screen.getByLabelText('Tìm sản phẩm');

  await fireEvent.changeText(field, 'Coc');
  await fireEvent.changeText(field, 'Coca');
  await act(async () => {
    jest.advanceTimersByTime(249);
  });
  expect(spy).not.toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(1);
  });

  await waitFor(() =>
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ q: 'Coca' })),
  );
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: SEVEN_UP })).toBeNull(),
  );
  expect(await screen.findByRole('button', { name: COCA })).toBeOnTheScreen();
});

test('typing before the debounce fires re-renders no tile', async () => {
  await renderWithProviders(<InventoryScreen />);
  await screen.findByRole('button', { name: COCA });
  await fireEvent.press(screen.getByRole('button', { name: 'Tìm' }));
  mockTileRenders.mockClear();
  await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), 'Coc');
  expect(screen.getByLabelText('Tìm sản phẩm').props.value).toBe('Coc');
  expect(mockTileRenders).not.toHaveBeenCalled();
});

test('closing the search clears the query and restores the grid', async () => {
  await renderWithProviders(<InventoryScreen />);
  await screen.findByRole('button', { name: COCA });
  await fireEvent.press(screen.getByRole('button', { name: 'Tìm' }));
  await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), 'Coca');
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: SEVEN_UP })).toBeNull(),
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Đóng tìm kiếm' }));
  expect(screen.getByRole('button', { name: 'Tìm' })).toBeOnTheScreen();
  expect(
    await screen.findByRole('button', { name: SEVEN_UP }),
  ).toBeOnTheScreen();
});

test('shows an empty state when nothing matches', async () => {
  await renderWithProviders(<InventoryScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Tìm' }));
  await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), 'zzzz');
  expect(await screen.findByText('Không tìm thấy sản phẩm')).toBeOnTheScreen();
});

test('shows an empty catalog message when there are no products', async () => {
  jest
    .spyOn(productsApi, 'listProducts')
    .mockResolvedValue({ items: [], next_cursor: null });
  await renderWithProviders(<InventoryScreen />);
  expect(await screen.findByText('Chưa có sản phẩm')).toBeOnTheScreen();
});

test('shows an error with retry that reloads', async () => {
  const spy = jest
    .spyOn(productsApi, 'listProducts')
    .mockRejectedValueOnce(new Error('boom'));
  await renderWithProviders(<InventoryScreen />);
  expect(await screen.findByText('Không tải được sản phẩm')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  expect(await screen.findByRole('button', { name: COCA })).toBeOnTheScreen();
  expect(spy).toHaveBeenCalledTimes(2);
});

const manyProducts = async (count: number) => {
  const { items } = await productsApi.listProducts({ limit: 1 });
  return Array.from({ length: count }, (_, i) => ({
    ...items[0]!,
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `Hàng ${i}`,
  }));
};

test('pull to refresh refetches', async () => {
  await renderWithProviders(<InventoryScreen />);
  await screen.findByRole('button', { name: COCA });
  const spy = jest.spyOn(productsApi, 'listProducts');
  const list = screen.getByTestId('inventory-list');
  await act(async () => {
    await list.props.refreshControl.props.onRefresh();
  });
  expect(spy).toHaveBeenCalledTimes(1);
});

test('reaching the end loads the next cursor page', async () => {
  const all = await manyProducts(30);
  const spy = jest
    .spyOn(productsApi, 'listProducts')
    .mockImplementation(async ({ cursor } = {}) =>
      cursor
        ? { items: all.slice(20), next_cursor: null }
        : { items: all.slice(0, 20), next_cursor: '20' },
    );
  await renderWithProviders(<InventoryScreen />);
  await screen.findByRole('button', { name: /Hàng 0,/ });
  expect(screen.queryByRole('button', { name: /Hàng 25,/ })).toBeNull();
  const list = screen.getByTestId('inventory-list');
  await act(async () => {
    list.props.onEndReached?.();
  });
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(spy).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: '20' }),
  );
});

test('end reached on the last page does nothing', async () => {
  const spy = jest.spyOn(productsApi, 'listProducts');
  await renderWithProviders(<InventoryScreen />);
  await screen.findByRole('button', { name: COCA });
  const list = screen.getByTestId('inventory-list');
  await act(async () => {
    list.props.onEndReached?.();
  });
  expect(spy).toHaveBeenCalledTimes(1);
});

test('tiles carry the product photo', async () => {
  await renderWithProviders(<InventoryScreen />);
  const tile = await screen.findByRole('button', { name: COCA });
  expect(within(tile).getByTestId('product-photo')).toBeOnTheScreen();
});

test('a product without a stock figure shows no "còn 0" badge', async () => {
  const real = productsApi.listProducts;
  jest.spyOn(productsApi, 'listProducts').mockImplementation(async (params) => {
    const page = await real(params);
    return {
      ...page,
      items: page.items.map(({ stock_quantity: _drop, ...rest }) => rest),
    };
  });
  await renderWithProviders(<InventoryScreen />);
  expect(
    await screen.findByRole('button', { name: 'Coca-Cola lon 330ml, 10.000đ' }),
  ).toBeOnTheScreen();
  expect(screen.queryByLabelText(/còn/)).toBeNull();
});

test('typing a search keeps the previous grid until the new page arrives', async () => {
  await renderWithProviders(<InventoryScreen />);
  await screen.findByRole('button', { name: SEVEN_UP });
  const release = holdNext(productsApi, 'listProducts');
  await fireEvent.press(screen.getByRole('button', { name: 'Tìm' }));
  await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), 'Coca');
  // The debounced request is pending: the old tiles must not blank out into a skeleton.
  await waitFor(() =>
    expect(productsApi.listProducts).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'Coca' }),
    ),
  );
  expect(screen.queryByTestId('inventory-skeleton')).toBeNull();
  expect(screen.getByRole('button', { name: SEVEN_UP })).toBeOnTheScreen();
  await act(async () => release());
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: SEVEN_UP })).toBeNull(),
  );
});

describe('low-stock filter (?filter=low)', () => {
  beforeEach(() => {
    mockParams = { filter: 'low' };
  });

  test('lists only the products running low, fewest first', async () => {
    await renderWithProviders(<InventoryScreen />);
    expect(
      await screen.findByRole('button', { name: SEVEN_UP }),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: COCA })).toBeNull();
    expect(screen.getAllByTestId('icon-CircleAlert')).toHaveLength(3);
  });

  test('the chip clears the filter', async () => {
    await renderWithProviders(<InventoryScreen />);
    await screen.findByRole('button', { name: SEVEN_UP });
    await fireEvent.press(
      screen.getByRole('button', { name: 'Bỏ lọc sắp hết hàng' }),
    );
    expect(router.setParams).toHaveBeenCalledWith({ filter: undefined });
  });

  test('narrowing the low-stock list re-renders no tile that keeps its place', async () => {
    await renderWithProviders(<InventoryScreen />);
    await screen.findByRole('button', { name: SEVEN_UP });
    const tiles = screen.getAllByRole('button', { name: /sắp hết/ });
    const first = tiles[0]!.props.accessibilityLabel.split(',')[0] as string;
    await fireEvent.press(screen.getByRole('button', { name: 'Tìm' }));
    // Let FlashList finish its layout passes, so only the search can add renders.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    mockTileRenders.mockClear();
    await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), first);
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: /sắp hết/ }).length,
      ).toBeLessThan(tiles.length),
    );
    // The first tile keeps cell 0 and its data: it must not render again.
    expect(mockTileRenders).not.toHaveBeenCalledWith(first);
  });

  test('search still narrows the low-stock list, ignoring accents', async () => {
    await renderWithProviders(<InventoryScreen />);
    await screen.findByRole('button', { name: SEVEN_UP });
    await fireEvent.press(screen.getByRole('button', { name: 'Tìm' }));
    await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), '7up');
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^7Up/ })).toHaveLength(1),
    );
  });
});

test('no filter chip without the low param', async () => {
  await renderWithProviders(<InventoryScreen />);
  await screen.findByRole('button', { name: COCA });
  expect(
    screen.queryByRole('button', { name: 'Bỏ lọc sắp hết hàng' }),
  ).toBeNull();
});
