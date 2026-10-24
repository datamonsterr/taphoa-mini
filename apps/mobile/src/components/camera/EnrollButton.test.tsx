import { fireEvent, screen } from '@testing-library/react-native';

import { colors } from '@/theme';
import { renderWithProviders } from '@/test/render';

import { EnrollButton } from './EnrollButton';

const label = 'Thêm vào kho với giá';

describe('EnrollButton', () => {
  it('normal: glass circle, tap target 64', async () => {
    await renderWithProviders(<EnrollButton onPress={jest.fn()} />);
    const button = screen.getByRole('button', { name: label });
    expect(button).toHaveStyle({ width: 64, height: 64 });
    expect(button).not.toHaveStyle({ backgroundColor: colors.warningSoft });
  });

  it('pulse: amber soft fill', async () => {
    await renderWithProviders(<EnrollButton pulse onPress={jest.fn()} />);
    expect(screen.getByRole('button', { name: label })).toHaveStyle({
      backgroundColor: colors.warningSoft,
    });
    expect(screen.getByTestId('enroll-pulse')).toBeOnTheScreen();
  });

  it('does not render the pulse halo when not pulsing', async () => {
    await renderWithProviders(<EnrollButton onPress={jest.fn()} />);
    expect(screen.queryByTestId('enroll-pulse')).toBeNull();
  });

  it('calls onPress', async () => {
    const onPress = jest.fn();
    await renderWithProviders(<EnrollButton onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: label }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('EnrollButton disabled', () => {
  it('is inert, dimmed, hinted and never pulses', async () => {
    const onPress = jest.fn();
    await renderWithProviders(
      <EnrollButton pulse disabled onPress={onPress} />,
    );
    const button = screen.getByRole('button', { name: label });
    expect(button).toBeDisabled();
    expect(button).toHaveStyle({ opacity: 0.4 });
    expect(button.props.accessibilityHint).toMatch(/Chủ tiệm/);
    expect(screen.queryByTestId('enroll-pulse')).toBeNull();
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});
