import { screen } from '@testing-library/react-native';

import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';

import { StockBadge } from './StockBadge';

test.each([
  [20, 'ok', 'Còn hàng', colors.surfaceSoft, colors.ink],
  [3, 'low', 'Sắp hết', colors.warningSoft, colors.warning],
  [0, 'out', 'Hết hàng', colors.dangerSoft, colors.danger],
  [-2, 'out', 'Hết hàng', colors.dangerSoft, colors.danger],
] as const)(
  'quantity %s has an accessible %s status and color',
  async (quantity, status, label, backgroundColor, color) => {
    await renderWithProviders(
      <StockBadge quantity={quantity} status={status} />,
    );
    const badge = screen.getByLabelText(`Tồn kho ${quantity}, ${label}`);
    expect(badge).toHaveTextContent(String(quantity));
    expect(badge).toHaveStyle({ backgroundColor });
    expect(screen.getByText(String(quantity))).toHaveStyle({ color });
    // Board 08: the chip is the count alone; the status word lives in the accessible name.
    expect(screen.queryByText(label)).toBeNull();
  },
);

test('on a photo the normal chip is white', async () => {
  await renderWithProviders(<StockBadge quantity={24} status="ok" onPhoto />);
  expect(screen.getByLabelText('Tồn kho 24, Còn hàng')).toHaveStyle({
    backgroundColor: colors.surface,
  });
});

test('untracked products have no badge', async () => {
  await renderWithProviders(<StockBadge quantity={null} status="untracked" />);
  expect(screen.queryByLabelText(/Tồn kho/)).toBeNull();
});

test('status and accessible name follow the app language', async () => {
  useSettingsStore.setState({ language: 'en' });
  await renderWithProviders(<StockBadge quantity={3} status="low" />);
  expect(screen.getByLabelText('Stock 3, Low stock')).toBeOnTheScreen();
});
