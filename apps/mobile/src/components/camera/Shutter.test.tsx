import { fireEvent, screen } from '@testing-library/react-native';

import { colors } from '@/theme';
import { renderWithProviders } from '@/test/render';

import { Shutter } from './Shutter';

describe('Shutter', () => {
  it('renders the 88px gold ring with the given label', async () => {
    await renderWithProviders(<Shutter label="Chụp" onPress={jest.fn()} />);
    const button = screen.getByRole('button', { name: 'Chụp' });
    expect(button).toHaveStyle({
      width: 88,
      height: 88,
      borderColor: colors.cameraRing,
    });
  });

  it('uses the retake label from the board', async () => {
    await renderWithProviders(<Shutter label="Chụp lại" onPress={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Chụp lại' })).toBeOnTheScreen();
  });

  it('calls onPress', async () => {
    const onPress = jest.fn();
    await renderWithProviders(<Shutter label="Chụp" onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('plays the press animation without breaking press handling', async () => {
    await renderWithProviders(<Shutter label="Chụp" onPress={jest.fn()} />);
    const button = screen.getByRole('button', { name: 'Chụp' });
    await fireEvent(button, 'pressIn');
    await fireEvent(button, 'pressOut');
    expect(button).toBeOnTheScreen();
  });

  it('is disabled and silent while busy', async () => {
    const onPress = jest.fn();
    await renderWithProviders(<Shutter label="Chụp" busy onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Chụp' });
    expect(button).toBeDisabled();
    expect(button).toBeBusy();
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});
