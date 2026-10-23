import { Tag } from 'lucide-react-native';
import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';

import { AlertPill } from './AlertPill';

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

test('amber pill with count and spoken label', async () => {
  const onPress = jest.fn();
  await renderWithProviders(
    <AlertPill count={3} label="món sắp hết" onPress={onPress} />,
  );
  const pill = screen.getByRole('button', { name: '3 món sắp hết' });
  expect(flat(pill)).toMatchObject({ backgroundColor: colors.warningSoft });
  expect(screen.getByText('3')).toBeOnTheScreen();
  await fireEvent.press(pill);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('neutral tone with custom icon', async () => {
  await renderWithProviders(
    <AlertPill
      count={2}
      label="món bán không có trong kho"
      icon={Tag}
      tone="neutral"
    />,
  );
  const pill = screen.getByRole('button', {
    name: '2 món bán không có trong kho',
  });
  expect(flat(pill)).toMatchObject({ backgroundColor: colors.surfaceSoft });
});
