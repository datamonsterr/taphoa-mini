import { fireEvent, screen } from '@testing-library/react-native';

import { camera, colors } from '@/theme';
import { renderWithProviders } from '@/test/render';

import { PricePill } from './PricePill';

describe('PricePill', () => {
  it('selected: white pill with price, opens alternatives', async () => {
    const onPress = jest.fn();
    await renderWithProviders(
      <PricePill
        id="d"
        variant="selected"
        price={10000}
        name="Sting đỏ"
        onPress={onPress}
      />,
    );
    const pill = screen.getByRole('button', {
      name: 'Sting đỏ 10.000đ, xem món khác',
    });
    expect(pill).toHaveStyle({ backgroundColor: camera.white, height: 40 });
    expect(screen.getByText('10.000')).toBeOnTheScreen();
    await fireEvent.press(pill);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith('d');
  });

  it('deselected: dark pill', async () => {
    await renderWithProviders(
      <PricePill
        id="d"
        variant="deselected"
        price={5000}
        name="Aquafina"
        onPress={jest.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Aquafina 5.000đ, xem món khác' }),
    ).toHaveStyle({ backgroundColor: camera.pillDark });
  });

  it('expanded state is exposed', async () => {
    await renderWithProviders(
      <PricePill
        id="d"
        variant="selected"
        price={5000}
        name="Aquafina"
        expanded
        onPress={jest.fn()}
      />,
    );
    expect(screen.getByRole('button')).toBeExpanded();
  });

  it('unknown: amber "?" pill with the enroll label', async () => {
    const onPress = jest.fn();
    await renderWithProviders(
      <PricePill id="d" variant="unknown" onPress={onPress} />,
    );
    const pill = screen.getByRole('button', {
      name: 'Chưa có trong kho, nhập giá',
    });
    expect(pill).toHaveStyle({ backgroundColor: colors.warningSoft });
    expect(screen.getByText('?')).toBeOnTheScreen();
    await fireEvent.press(pill);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
