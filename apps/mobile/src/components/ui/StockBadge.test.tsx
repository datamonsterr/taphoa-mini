import { screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';

import { StockBadge } from './StockBadge';

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

test('normal: white ground, no alert icon', async () => {
  await renderWithProviders(<StockBadge quantity={24} />);
  const badge = screen.getByLabelText('còn 24');
  expect(flat(badge)).toMatchObject({ backgroundColor: colors.surface });
  expect(screen.getByText('24')).toBeOnTheScreen();
});

test('low: amber ground and spoken warning', async () => {
  await renderWithProviders(<StockBadge quantity={3} low />);
  const badge = screen.getByLabelText('sắp hết: còn 3');
  expect(flat(badge)).toMatchObject({ backgroundColor: colors.warningSoft });
  expect(flat(screen.getByText('3'))).toMatchObject({ color: colors.warning });
});
