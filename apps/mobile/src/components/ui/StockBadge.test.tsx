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
    expect(badge).toHaveTextContent(new RegExp(String(quantity)));
    expect(badge).toHaveStyle({ backgroundColor });
    expect(screen.getByText(label)).toHaveStyle({ color });
  },
);

test('untracked products have no badge', async () => {
  await renderWithProviders(<StockBadge quantity={null} status="untracked" />);
  expect(screen.queryByLabelText(/Tồn kho/)).toBeNull();
});

test('status and accessible name follow the app language', async () => {
  useSettingsStore.setState({ language: 'en' });
  await renderWithProviders(<StockBadge quantity={3} status="low" />);
  expect(screen.getByLabelText('Stock 3, Low stock')).toBeOnTheScreen();
});
