import { Camera } from 'lucide-react-native';

import { colors } from '@/theme';
import { renderWithProviders } from '@/test/render';

import { Icon } from './Icon';

jest.mock('lucide-react-native', () => ({
  Camera: jest.fn(() => null),
}));

const camera = Camera as unknown as jest.Mock;

test('uses design-system size, stroke and ink colour by default', async () => {
  await renderWithProviders(<Icon icon={Camera} />);
  expect(camera.mock.calls[0]?.[0]).toMatchObject({
    size: 26,
    strokeWidth: 2.25,
    color: colors.ink,
  });
});

test('accepts overrides', async () => {
  await renderWithProviders(
    <Icon icon={Camera} size={20} strokeWidth={2} color="#fff" />,
  );
  expect(camera.mock.calls.at(-1)?.[0]).toMatchObject({
    size: 20,
    strokeWidth: 2,
    color: '#fff',
  });
});

test('hides itself from accessibility with aria-hidden, not a DOM-invalid `accessible` prop', async () => {
  await renderWithProviders(<Icon icon={Camera} />);
  const props = camera.mock.calls.at(-1)?.[0];
  expect(props).toMatchObject({ 'aria-hidden': true });
  expect(props).not.toHaveProperty('accessible');
});
