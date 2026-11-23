import { router } from 'expo-router';

import * as stockApi from '@/lib/api/stock';
import { PRODUCT_IDS } from '@/test/mock';
import { fireEvent, renderApp, screen, waitFor } from '@/test/router';

afterEach(() => jest.restoreAllMocks());

const segment = (name: 'Sản phẩm' | 'Tồn kho') =>
  screen.getByRole('radio', { name });

test('switching segments stays on the Kho tab and never pushes a route', async () => {
  const push = jest.spyOn(router, 'push');
  await renderApp('/inventory');
  await screen.findByTestId('inventory-list');
  expect(segment('Sản phẩm')).toBeChecked();
  await fireEvent.press(segment('Tồn kho'));
  expect(await screen.findByTestId('stock-list')).toBeOnTheScreen();
  expect(segment('Tồn kho')).toBeChecked();
  expect(screen).toHavePathname('/inventory');
  expect(screen).toHaveSearchParams({ segment: 'stock' });
  await fireEvent.press(segment('Sản phẩm'));
  expect(await screen.findByTestId('inventory-list')).toBeOnTheScreen();
  expect(screen).toHaveSearchParams({ segment: 'products' });
  expect(push).not.toHaveBeenCalled();
});

test('cold /stock replaces into the Kho stock segment with status=all', async () => {
  await renderApp('/stock');
  expect(await screen.findByTestId('stock-list')).toBeOnTheScreen();
  expect(screen).toHavePathname('/inventory');
  expect(screen).toHaveSearchParams({ segment: 'stock', status: 'all' });
  expect(segment('Tồn kho')).toBeChecked();
});

test.each(['low', 'out', 'ok'] as const)(
  '/stock?status=%s carries the filter into the stock segment',
  async (status) => {
    const list = jest.spyOn(stockApi, 'listStock');
    await renderApp(`/stock?status=${status}`);
    await screen.findByTestId('stock-list');
    expect(screen).toHavePathname('/inventory');
    expect(screen).toHaveSearchParams({ segment: 'stock', status });
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith({ status, cursor: null }),
    );
  },
);

test('an unsupported /stock filter falls back to all', async () => {
  await renderApp('/stock?status=bogus');
  await screen.findByTestId('stock-list');
  expect(screen).toHaveSearchParams({ segment: 'stock', status: 'all' });
});

test('the canonical alert URL opens the filtered stock segment', async () => {
  const list = jest.spyOn(stockApi, 'listStock');
  await renderApp('/inventory?segment=stock&status=low');
  await screen.findByTestId('stock-list');
  await waitFor(() =>
    expect(list).toHaveBeenCalledWith({ status: 'low', cursor: null }),
  );
  expect(
    screen.getByRole('button', { name: 'Lọc tồn kho' }),
  ).toHaveAccessibilityValue({ text: 'Sắp hết' });
});

test('Back from a product opened in the stock segment returns to that segment', async () => {
  await renderApp('/inventory?segment=stock&status=all');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Coca-Cola lon 330ml' }),
  );
  await waitFor(() =>
    expect(screen).toHavePathname(`/product/${PRODUCT_IDS.coca}`),
  );
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Quay lại' }),
  );
  expect(await screen.findByTestId('stock-list')).toBeOnTheScreen();
  expect(screen).toHavePathname('/inventory');
  expect(segment('Tồn kho')).toBeChecked();
});
