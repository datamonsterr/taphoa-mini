import { fireEvent, screen } from '@testing-library/react-native';
import { renderWithProviders } from '@/test/render';
import { useSettingsStore } from '@/stores/settings';
import { DocumentButton } from './DocumentButton';

test('floats within its image parent and reads the receipt on press', async () => {
  const onPress = jest.fn();
  await renderWithProviders(<DocumentButton onPress={onPress} />);
  expect(screen.getByTestId('document-button-position')).toHaveStyle({
    position: 'absolute',
    right: 16,
    bottom: 16,
    zIndex: 10,
  });
  await fireEvent.press(
    screen.getByRole('button', { name: 'Đọc hóa đơn nhập' }),
  );
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('has an English accessible label', async () => {
  useSettingsStore.setState({ language: 'en' });
  await renderWithProviders(<DocumentButton onPress={jest.fn()} />);
  expect(
    screen.getByRole('button', { name: 'Read import receipt' }),
  ).toBeOnTheScreen();
});
