import { fireEvent, screen } from '@testing-library/react-native';

import { colors } from '@/theme';
import { renderWithProviders } from '@/test/render';

import { AddButton } from './AddButton';

describe('AddButton', () => {
  it('disabled: dimmed, silent, accessibility disabled', async () => {
    const onPress = jest.fn();
    await renderWithProviders(<AddButton disabled onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Thêm vào giỏ' });
    expect(button).toBeDisabled();
    expect(button).toHaveStyle({ opacity: 0.4 });
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('active: accent fill, calls onPress', async () => {
    const onPress = jest.fn();
    await renderWithProviders(<AddButton onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Thêm vào giỏ' });
    expect(button).toBeEnabled();
    expect(button).toHaveStyle({ backgroundColor: colors.accent });
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('add-badge')).toBeNull();
  });

  it('active with batch: shows count badge and the batch label', async () => {
    await renderWithProviders(<AddButton count={3} onPress={jest.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Thêm tất cả vào giỏ' }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('add-badge')).toHaveTextContent('3');
  });

  it('pops when the count changes', async () => {
    const { rerender } = await renderWithProviders(
      <AddButton count={2} onPress={jest.fn()} />,
    );
    await rerender(<AddButton count={3} onPress={jest.fn()} />);
    expect(screen.getByTestId('add-badge')).toHaveTextContent('3');
  });

  it('hides a zero or one count badge', async () => {
    await renderWithProviders(<AddButton count={0} onPress={jest.fn()} />);
    expect(screen.queryByTestId('add-badge')).toBeNull();
  });
});
