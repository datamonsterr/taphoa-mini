import { fireEvent, screen } from '@testing-library/react-native';

import { camera, colors } from '@/theme';
import { renderWithProviders } from '@/test/render';

import { DetectionBox } from './DetectionBox';

const box = { x: 20, y: 52, width: 80, height: 126 };

describe('DetectionBox', () => {
  it('selected: white border, number badge, selected state', async () => {
    await renderWithProviders(
      <DetectionBox
        id="d"
        box={box}
        state="selected"
        number={2}
        name="Sting đỏ"
        onPress={jest.fn()}
      />,
    );
    const el = screen.getByRole('button', { name: 'Sting đỏ, đã chọn' });
    expect(el).toBeSelected();
    expect(el).toHaveStyle({
      left: 20,
      top: 52,
      width: 80,
      height: 126,
    });
    expect(screen.getByTestId('box-frame')).toHaveStyle({
      borderColor: camera.white,
      borderWidth: 3,
      borderStyle: 'solid',
    });
    expect(screen.getByTestId('box-badge')).toHaveTextContent('2');
    expect(screen.getByTestId('box-badge')).toHaveStyle({
      backgroundColor: colors.accent,
    });
  });

  it('selected without a number (single mode): no badge', async () => {
    await renderWithProviders(
      <DetectionBox
        id="d"
        box={box}
        state="selected"
        name="Sting đỏ"
        onPress={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('box-badge')).toBeNull();
  });

  it('deselected: dashed white, empty ring, not selected', async () => {
    await renderWithProviders(
      <DetectionBox
        id="d"
        box={box}
        state="deselected"
        name="Sting đỏ"
        onPress={jest.fn()}
      />,
    );
    const el = screen.getByRole('button', { name: 'Sting đỏ, bỏ chọn' });
    expect(el).not.toBeSelected();
    expect(screen.getByTestId('box-frame')).toHaveStyle({
      borderStyle: 'dashed',
      borderWidth: 2,
      borderColor: camera.boxOffLine,
    });
    expect(screen.getByTestId('box-ring')).toBeOnTheScreen();
    expect(screen.queryByTestId('box-badge')).toBeNull();
  });

  it('low match: dashed amber, no badge or ring', async () => {
    await renderWithProviders(
      <DetectionBox
        id="d"
        box={box}
        state="low"
        name="Chưa rõ"
        onPress={jest.fn()}
      />,
    );
    const el = screen.getByRole('button', {
      name: 'Chưa rõ, chưa có trong kho',
    });
    expect(el).not.toBeSelected();
    expect(screen.getByTestId('box-frame')).toHaveStyle({
      borderStyle: 'dashed',
      borderColor: colors.warningSoft,
      borderWidth: 3,
    });
    expect(screen.queryByTestId('box-ring')).toBeNull();
    expect(screen.queryByTestId('box-badge')).toBeNull();
  });

  it('tap toggles via onPress', async () => {
    const onPress = jest.fn();
    await renderWithProviders(
      <DetectionBox
        id="d"
        box={box}
        state="selected"
        number={1}
        name="Sting đỏ"
        onPress={onPress}
      />,
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Sting đỏ, đã chọn' }),
    );
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith('d');
  });

  it('animates between states without remounting', async () => {
    const { rerender } = await renderWithProviders(
      <DetectionBox
        id="d"
        box={box}
        state="selected"
        number={1}
        name="Sting đỏ"
        onPress={jest.fn()}
      />,
    );
    await rerender(
      <DetectionBox
        id="d"
        box={box}
        state="deselected"
        name="Sting đỏ"
        onPress={jest.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Sting đỏ, bỏ chọn' }),
    ).toBeOnTheScreen();
  });
});
