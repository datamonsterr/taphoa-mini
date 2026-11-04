import { screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';

import { DifferencePill, differenceStatus } from './DifferencePill';

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

test('differenceStatus', () => {
  expect(differenceStatus(0)).toBe('match');
  expect(differenceStatus(-1)).toBe('short');
  expect(differenceStatus(1)).toBe('extra');
});

test('match: green, visible 0đ, spoken Khớp', async () => {
  await renderWithProviders(<DifferencePill difference={0} />);
  expect(flat(screen.getByLabelText('Khớp'))).toMatchObject({
    backgroundColor: colors.successSoft,
  });
  expect(screen.getByText('0đ')).toBeOnTheScreen();
});

test('short: red, visible signed amount, spoken Thiếu (board 13)', async () => {
  await renderWithProviders(<DifferencePill difference={-10000} />);
  expect(flat(screen.getByLabelText('Thiếu 10.000đ'))).toMatchObject({
    backgroundColor: colors.dangerSoft,
  });
  expect(screen.getByText('−10.000đ')).toBeOnTheScreen();
});

test('extra: amber, visible signed amount, spoken Dư (board 13)', async () => {
  await renderWithProviders(<DifferencePill difference={5000} />);
  expect(flat(screen.getByLabelText('Dư 5.000đ'))).toMatchObject({
    backgroundColor: colors.warningSoft,
  });
  expect(screen.getByText('+5.000đ')).toBeOnTheScreen();
});

test('labels override the spoken words', async () => {
  const labels = { match: 'Matches', short: 'Short', extra: 'Over' };
  await renderWithProviders(
    <DifferencePill difference={-5000} labels={labels} />,
  );
  expect(screen.getByText('−5.000đ')).toBeOnTheScreen();
  expect(screen.getByLabelText('Short 5.000đ')).toBeOnTheScreen();
});
